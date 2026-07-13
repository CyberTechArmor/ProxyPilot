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
import { containerNameForProject } from './provision.js';
import { buildCheckpointScript } from './template.js';
import { getSlot, getConnector, decryptConnectorKey, listPrices } from './connectors.js';
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
import {
  CONCEPT_CHAT_TOOLS, buildConceptChatSystemPrompt, buildMockupSystemPrompt, buildMockupTask,
  buildInventoryExtractionPrompt, buildInventoryExtractionTask,
  extractMockupHtml, isPlausibleMockup, parseInventory, inventoryCounts,
  classifyConceptTurn, buildConceptTranscript, conversationRecap,
  estimateConceptTurnTokens, estimateInventoryTokens,
  mockupIdForCycle, mockupFileName, MOCKUP_CURRENT, INVENTORY_PATH,
  buildDesignTokenExtractionPrompt, buildDesignTokenExtractionTask, parseDesignTokens,
  renderDesignTokensCss, DESIGN_TOKENS_PATH, DESIGN_CSS_PATH,
} from './concept-logic.js';
import { callModelTurn } from './model-client.js';
import { startBuild } from './audit.js';

const APP_DIR = '/srv/app';
const nowIso = () => new Date().toISOString();

// The instruction the auto-started initial build runs with. Approving the design
// (the "Are you ready to build?" gesture) both locks the design AND kicks off the
// first build — so the working app replaces the placeholder without the Builder
// having to describe a change. The Build-cycle panel is for adjustments AFTER
// this initial build. The audit still runs first (it may raise rule questions).
const INITIAL_BUILD_INSTRUCTION = 'Build the working application from the approved design inventory: implement every screen, field, and action it defines on the pinned framework, so the live URL serves the real app in place of the placeholder. Reproduce the approved design\'s look — load state/design.css and match the tokens in state/design-tokens.json (colors, fonts, spacing, radii, component styling); do not fall back to a generic style.';

// Bound the HTML we round-trip so a runaway mockup can't blow the token envelope
// (R5) or the working tree. A real mockup is well under this.
const MAX_MOCKUP_CHARS = 200000;
const MAX_MOCKUP_FEEDBACK_CHARS = 60000; // how much prior HTML we feed back for iteration

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

function effectivePrice(connectorId, model) {
  const now = nowIso();
  return listPrices(connectorId).find((p) => p.model === model && String(p.effective_at) <= now) || null;
}

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

// Ledger + cycle usage after a model call.
function recordSpend({ projectId, cycleId, connector, model, usage }) {
  const cents = costCentsForUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, effectivePrice(connector.id, model));
  addCycleUsage(cycleId, { tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0), costCents: cents });
  try {
    insertLedgerEntry({ projectId, cycleId, connectorId: connector.id, model, inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, costCents: cents, wallClockMs: 0 });
  } catch (e) { console.warn('[mock2] concept ledger write failed:', e?.message); }
}

// ---- container IO (concept-local; the concept stage writes ONLY mockups) ----

function containerSh(containerName, script, { timeoutMs = 120000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

// Write a FIXED-path file into the working tree (base64-streamed — no quoting
// hazard from model-authored HTML). relPath is an orchestrator constant (a mockup
// under state/mockups or state/inventory.json), never a model-supplied path.
async function writeWorkingFile(containerName, relPath, content) {
  const script = `d="${APP_DIR}/${relPath}"; mkdir -p "$(dirname "$d")"; printf '%s' '${b64(content)}' | base64 -d > "$d" && echo ok`;
  const r = await containerSh(containerName, script);
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

// ---- a concept chat turn ----

// startConceptTurn — the Builder sent a chat message. Synchronous setup (lock,
// insert the user message, quota check, create the concept cycle), then fire the
// background turn. Returns { status:'started'|'refused'|'error', cycle, userMessage, error }.
export async function startConceptTurn({ project, message, user, actingAsAdmin = 0, mode = 'design' }) {
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

  // Record the Builder's message (acting_as_admin stamped, ADR-007).
  getOrCreateChat(projectId);
  const userMessage = insertMessage({ projectId, authorUserId: user.id, actingAsAdmin, kind: 'user', body: message });

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

  runConceptTurn({ project, cycle: getCycle(cycle.id), ready, framework, user, actingAsAdmin, message, mode: turnMode }).catch((err) => {
    console.error(`[mock2] concept turn crashed for project ${projectId}:`, err?.message || err);
    try { finishCycle(cycle.id, { status: 'failed', error: `concept turn crashed: ${err?.message || err}` }); } catch { /* ignore */ }
    try { insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Something went wrong on that turn: ${err?.message || err}` }); } catch { /* ignore */ }
    setJob(projectId, { phase: 'failed', message: `turn crashed: ${err?.message || err}` });
    scheduleJobCleanup(projectId);
  });

  return { status: 'started', cycle: getCycle(cycle.id), userMessage };
}

async function runConceptTurn({ project, cycle, ready, framework, user, actingAsAdmin, message, mode = 'design' }) {
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
  const transcript = buildConceptTranscript(listMessages(projectId));
  const hasMockup = !!project.current_mockup_id;
  const system = buildConceptChatSystemPrompt({ designSystem: framework.design_system_md, projectName: project.name, hasMockup, mode });

  const chatRes = await callModelTurn({
    connector: ready.chat.connector, apiKey: ready.chat.apiKey, model: ready.chat.model,
    system, tools: planMode ? [] : CONCEPT_CHAT_TOOLS, transcript, maxTokens: 4000,
  });
  if (!chatRes.ok) {
    finishCycle(cycle.id, { status: 'failed', error: chatRes.error });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `The design partner couldn't respond: ${chatRes.error}` });
    setJob(projectId, { phase: 'failed', message: chatRes.error });
    return scheduleJobCleanup(projectId);
  }
  recordSpend({ projectId, cycleId: cycle.id, connector: ready.chat.connector, model: ready.chat.model, usage: chatRes.usage });
  const decision = classifyConceptTurn(chatRes.toolCalls);

  // 2) If the model asked for a mockup, render it on the mockup slot and write it
  //    into the container (the only container write the concept stage performs).
  let mockupNote = null;
  if (decision.generateMockup) {
    setJob(projectId, { phase: 'designing', message: 'Designing the mockup…', kind: 'turn', cycleId: cycle.id });
    let currentHtml = null;
    if (hasMockup) {
      const cur = await readWorkingFile(containerName, MOCKUP_CURRENT);
      if (cur.ok) currentHtml = String(cur.content || '').slice(0, MAX_MOCKUP_FEEDBACK_CHARS);
    }
    const mockupTask = buildMockupTask({
      brief: decision.brief, currentHtml, projectName: project.name,
      conversation: conversationRecap(listMessages(projectId)),
    });
    const mockupRes = await callModelTurn({
      connector: ready.mockup.connector, apiKey: ready.mockup.apiKey, model: ready.mockup.model,
      system: buildMockupSystemPrompt({ designSystem: framework.design_system_md }),
      tools: [], transcript: [{ role: 'user', text: mockupTask }], maxTokens: 16000,
    });
    if (mockupRes.ok) {
      recordSpend({ projectId, cycleId: cycle.id, connector: ready.mockup.connector, model: ready.mockup.model, usage: mockupRes.usage });
      const html = extractMockupHtml(mockupRes.text).slice(0, MAX_MOCKUP_CHARS);
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
          mockupNote = 'Updated the mockup — open the preview to see it (it opens in a new tab).';
          insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `${mockupNote}${sha ? ` (checkpoint ${sha.slice(0, 8)})` : ''}` });
        } else {
          insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `The mockup couldn't be saved: ${w1.error || w2.error}` });
        }
      } else {
        insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: 'The design model did not return a usable mockup this time — the previous version is unchanged. Try rephrasing what you want to see.' });
      }
    } else {
      insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `The design model couldn't render a mockup: ${mockupRes.error}` });
    }
  }

  // 3) Always post the concept partner's plain-language reply. Synthesize one if
  //    the model only called the tool with no text.
  const replyText = String(chatRes.text || '').trim()
    || (mockupNote ? "I've updated the mockup — take a look and tell me what to change." : "I'm here — tell me a bit more about what you'd like to build.");
  insertMessage({ projectId, authorUserId: null, kind: 'assistant', cycleId: cycle.id, body: replyText });

  finishCycle(cycle.id, { status: 'succeeded' });
  // Keep the human lock held (the Builder is actively working — the idle sweep
  // reclaims it, or design approval releases it: ADR-004 "release on idle/approval").
  touchLock(projectId, holder);
  setJob(projectId, { phase: 'done', message: 'Ready', kind: 'turn', cycleId: cycle.id });
  scheduleJobCleanup(projectId);
}

// ---- the design-approval gesture (Stage 1's ONLY exit — sign-off #1) ----

// startDesignApproval — the Builder approved the design. Synchronous guards, then
// fire the background extraction/commit. Returns { status:'started'|'error', cycle, error }.
export async function startDesignApproval({ project, user, actingAsAdmin = 0 }) {
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

  runDesignApproval({ project, cycle: getCycle(cycle.id), ready, framework, user, actingAsAdmin }).catch((err) => {
    console.error(`[mock2] design approval crashed for project ${projectId}:`, err?.message || err);
    try { finishCycle(cycle.id, { status: 'failed', error: `approval crashed: ${err?.message || err}` }); } catch { /* ignore */ }
    try { insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Design approval failed: ${err?.message || err}` }); } catch { /* ignore */ }
    setJob(projectId, { phase: 'failed', message: `approval crashed: ${err?.message || err}` });
    scheduleJobCleanup(projectId);
  });

  return { status: 'started', cycle: getCycle(cycle.id) };
}

async function runDesignApproval({ project, cycle, ready, framework, user, actingAsAdmin }) {
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
  const extractRes = await callModelTurn({
    connector: ready.chat.connector, apiKey: ready.chat.apiKey, model: ready.chat.model,
    system: buildInventoryExtractionPrompt(), tools: [],
    transcript: [{ role: 'user', text: buildInventoryExtractionTask({ html, projectName: project.name }) }],
    maxTokens: 8000,
  });
  if (extractRes.ok) recordSpend({ projectId, cycleId: cycle.id, connector: ready.chat.connector, model: ready.chat.model, usage: extractRes.usage });
  const parsed = extractRes.ok ? parseInventory(extractRes.text) : { ok: false, error: extractRes.error };
  if (!parsed.ok) {
    finishCycle(cycle.id, { status: 'failed', error: `inventory extraction failed: ${parsed.error}` });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Couldn't extract the design inventory: ${parsed.error}. The design is not approved — try again.` });
    setJob(projectId, { phase: 'failed', message: parsed.error });
    return scheduleJobCleanup(projectId);
  }
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
      maxTokens: 2000,
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

  insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Design approved — the design inventory (${counts.screens} screen${counts.screens === 1 ? '' : 's'}) is saved to the repository and Build is now unlocked. The original mockup is archived at the design preview so you can always see where the design started.` });
  setJob(projectId, { phase: 'approved', message: 'Design approved — Build unlocked.', kind: 'approval', cycleId: cycle.id, changeSeq: record?.seq || null });
  console.log(`[mock2] project ${projectId} design approved (inventory ${counts.screens} screens, change record ${record?.seq ?? '—'})`);
  scheduleJobCleanup(projectId);

  // 7) Auto-start the initial build. Approval both locks the design AND begins
  //    building the working app (the "Are you ready to build?" dialog promises
  //    exactly this), so the Builder doesn't have to describe a change to get the
  //    real app. The lock was just released, so startBuild can take it as the
  //    cycle holder. The audit runs first: if it raises rule questions they show
  //    in the chat to confirm and the build resumes once answered; if the build
  //    can't start (no runner model, quota, …) we say so and leave Build unlocked
  //    for a manual press.
  try {
    const res = await startBuild({ project: getProject(projectId), instruction: INITIAL_BUILD_INSTRUCTION, user, actingAsAdmin });
    if (res.status === 'started') {
      insertMessage({ projectId, kind: 'system', body: 'Starting the initial build from the approved design — auditing it against the rules and framework first.' });
    } else if (res.status !== 'refused') {
      // 'refused' already posts its own "Build not started — …" message.
      insertMessage({ projectId, kind: 'system', body: `Design is locked in, but the initial build didn't start automatically — ${res.error} Start it from the Build cycle panel below.` });
    }
  } catch (e) {
    console.warn(`[mock2] auto-build after approval failed for project ${projectId}:`, e?.message || e);
    insertMessage({ projectId, kind: 'system', body: 'Design is locked in, but the initial build didn’t start automatically. Start it from the Build cycle panel below.' });
  }
}
