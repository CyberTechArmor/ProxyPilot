// Mock2 ASK lane — the build chat's conversational mode (host/model
// orchestration half; the pure decisions live in ask-logic.js).
//
// An ask is a question about the codebase or a bounded operational task ("run
// the tests", "add a user to the database", "curl the API with the stored
// credentials") answered by a small tool loop over the SAME fenced container
// the builds use — with none of the build ceremony: no audit gate, no
// checkpoint, no deploy, no change record. The lane must not modify the CODE
// (read/exec tools only, plus a command blocklist backstop) — a requested code
// change is redirected to a build cycle; user-requested runtime actions
// against the app and its data are in scope.
//
// It mirrors audit.js's shape: the 202+poll job map, the build_runner slot via
// buildRunnerReady (the only slot with tool-capable models), quota check before
// spending, spend recorded to the quota ledger (cycle-less entries), and the
// checkout lock held while it can execute commands (ADR-004 — exec can touch
// the tree even though the prompt forbids it; the lock keeps an ask and a build
// from interleaving).
//
// Web search: when the connector is Anthropic, the API's server-side web_search
// tool rides along (ask-logic.webSearchServerTools, default ON for this lane) —
// the search runs inside Anthropic's infrastructure during the model call, so
// the build fence stays sealed.
//
// Terminology (risk R7): nothing here is named "agent".

import { logAudit } from '../db.js';
import { getLaneTuning } from './settings.js';
import { applyLaneTuning } from './lane-tuning-logic.js';
import { getProject, updateProject } from './projects.js';
import { containerNameForProject } from './provision.js';
import { acquireLock, releaseLock, touchLock } from './locks.js';
import { insertMessage, getOrCreateChat, listMessages } from './chats.js';
import { saveChatImages, hydrateAttachments } from './chat-images.js';
import { effectivePrice } from './connectors.js';
import { getApplicableQuota, periodUsage, insertLedgerEntry } from './quotas.js';
import { canStartCycle, costCentsForUsage } from './quota-logic.js';
import { countRunningCycles } from './cycles.js';
import { callStepTurn, stepSystemPrompt } from './harness-steps.js';
import {
  buildRunnerReady, execInContainer, readFileInContainer,
} from './runner.js';
import { getPublishedComponentWithVersion, listProjectComponents } from './components.js';
import { formatComponentForModel, parseContractJson, buildInstalledComponentsSection } from './component-logic.js';
import {
  ASK_TOOLS, ASK_MAX_TURNS, estimateAskTokens,
  buildAskSystemPrompt, buildAskTask, askCommandAllowed, webSearchServerTools,
  buildAskContextBlock, ASK_CONTEXT_MAX_MESSAGES,
} from './ask-logic.js';

const nowIso = () => new Date().toISOString();

// Live ask-job progress, keyed by project id (house 202+poll pattern). One ask
// per project at a time.
export const activeAskJobs = new Map();

export function getAskJobStatus(projectId) {
  return activeAskJobs.get(Number(projectId)) || null;
}

function setJob(projectId, patch) {
  const cur = activeAskJobs.get(Number(projectId)) || {};
  activeAskJobs.set(Number(projectId), { ...cur, ...patch, updatedAt: Date.now() });
}
function scheduleJobCleanup(projectId) {
  setTimeout(() => activeAskJobs.delete(Number(projectId)), 120000);
}
function askJobActive(projectId) {
  const j = activeAskJobs.get(Number(projectId));
  return !!j && !['done', 'failed'].includes(j.phase);
}

function recordSpend({ projectId, connector, model, usage, step = null }) {
  const cents = costCentsForUsage({
    inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0,
    cacheReadTokens: usage.cacheReadInputTokens || 0, cacheWriteTokens: usage.cacheCreationInputTokens || 0,
  }, effectivePrice(connector.id, model));
  try {
    insertLedgerEntry({ projectId, cycleId: null, connectorId: connector.id, model, inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, costCents: cents, wallClockMs: 0, step });
  } catch (e) { console.warn('[mock2] ask ledger write failed:', e?.message); }
  return cents;
}

// startAsk — validate, take the lock, fire the background loop. Returns
// { status: 'started' | 'error', error }. `images` is the VALIDATED list from
// chat-image-logic.validateChatImages — a screenshot of a bug or an API doc
// rides the question straight into the model call.
export async function startAsk({ project, question, user, actingAsAdmin = 0, images = [] }) {
  const projectId = Number(project.id);
  const q = buildAskTask(question);
  if (!q) return { status: 'error', error: 'A question (or task) is required.' };
  if (project.lifecycle !== 'active') {
    return { status: 'error', error: `The project must be online to ask (it is "${project.lifecycle}").` };
  }
  if (askJobActive(projectId)) return { status: 'error', error: 'An ask is already running for this project — wait for its answer.' };
  const ready = buildRunnerReady();
  if (!ready.ok) return { status: 'error', error: ready.reason };

  // Quota — the ask spends real tokens, so it is refused exactly like a cycle
  // when the budget can't cover the reservation.
  const est = estimateAskTokens();
  const estCostCents = costCentsForUsage(est, effectivePrice(ready.connector.id, ready.model));
  const quota = getApplicableQuota(projectId, 'monthly');
  if (quota) {
    const usage = periodUsage({ scope: quota.scope, projectId: quota.scope === 'project' ? quota.project_id : null, period: quota.period });
    const verdict = canStartCycle(
      { estCostCents },
      { budgetCents: quota.budget_cents, bufferPct: quota.buffer_pct, maxConcurrentCycles: quota.max_concurrent_cycles },
      { spentCents: usage.costCents, runningCycles: countRunningCycles(quota.scope === 'project' ? projectId : null) },
    );
    if (!verdict.ok) return { status: 'error', error: verdict.reason };
  }

  // The lock: an ask can execute commands in the container, so it is a writer
  // for locking purposes (ADR-004) — it must not interleave with a build cycle.
  const holder = { type: 'user', id: user.id };
  const lock = acquireLock({ projectId, requester: holder, role: (actingAsAdmin || user.role === 'admin') ? 'admin' : 'editor' });
  if (!lock.ok) return { status: 'error', error: lock.reason || 'A build is running — ask again when it finishes.' };

  getOrCreateChat(projectId);
  // Snapshot the recent conversation BEFORE inserting this question — the ask
  // transcript is otherwise blank and "that/it" references dangle.
  let contextMessages = [];
  try { contextMessages = listMessages(projectId).slice(-ASK_CONTEXT_MAX_MESSAGES); } catch { contextMessages = []; }
  let attachments = [];
  try { attachments = saveChatImages(projectId, images); } catch (e) { console.warn('[mock2] ask image save failed:', e?.message); }
  insertMessage({ projectId, authorUserId: user.id, actingAsAdmin, kind: 'user', body: q, attachments });
  setJob(projectId, { phase: 'running', message: 'Looking into it…', startedAt: Date.now(), turns: 0 });

  runAsk({ project, projectId, holder, ready, question: q, attachments, contextMessages })
    .catch((err) => {
      console.error(`[mock2] ask crashed for project ${projectId}:`, err?.message || err);
      try { insertMessage({ projectId, kind: 'system', body: `The ask failed: ${err?.message || err}` }); } catch { /* ignore */ }
      setJob(projectId, { phase: 'failed', message: `ask crashed: ${err?.message || err}`, partial: null });
      scheduleJobCleanup(projectId);
    })
    .finally(() => {
      try { releaseLock(projectId, holder); } catch { /* ignore */ }
    });

  return { status: 'started' };
}

async function runAsk({ project, projectId, holder, ready, question, attachments = [], contextMessages = [] }) {
  const containerName = project.container_name || containerNameForProject(projectId);

  // The installed-components section rides along so questions about auth /
  // bootstrap / directory land on the standard components. Best-effort.
  let installedSection = '';
  try {
    const installed = listProjectComponents(projectId)
      .filter((r) => r.status === 'installed')
      .map((r) => ({ key: r.key, name: r.name, version: r.pinned_version, contract: parseContractJson(r.contract_json) }));
    installedSection = buildInstalledComponentsSection(installed);
  } catch { installedSection = ''; }

  const serverTools = webSearchServerTools({ provider: ready.connector.provider, env: process.env, defaultOn: true });
  const system = stepSystemPrompt('ask', buildAskSystemPrompt({
    projectName: project.name, webPort: project.web_port || 3000,
    webSearch: serverTools.length > 0, installedComponentsSection: installedSection,
  }), { PROJECT_NAME: project.name, WEB_PORT: project.web_port || 3000, COMPONENTS: installedSection });
  // The question's image attachments ride the first turn (an ask is a fresh
  // transcript, so this is the only place they're paid for).
  const askImages = hydrateAttachments(projectId, attachments);
  const contextBlock = buildAskContextBlock(contextMessages);
  const firstTurn = contextBlock
    ? `${contextBlock}\n\n# The user's message NOW (answer this)\n${question}`
    : question;
  const transcript = [{ role: 'user', text: firstTurn, ...(askImages.length ? { images: askImages } : {}) }];

  // Streaming (where the provider supports it — Anthropic): visible text
  // accumulates on the job as `partial` across the tool turns, so the user
  // watches the answer form instead of staring at a spinner. Throttled pushes;
  // the durable chat message replaces the preview at the end.
  let partial = '';
  let lastPartialPush = 0;
  let turnStreamed = false;
  const pushPartial = () => {
    const now = Date.now();
    if (now - lastPartialPush < 250) return;
    lastPartialPush = now;
    setJob(projectId, { partial });
  };
  const onDelta = (t) => {
    if (!turnStreamed) {
      turnStreamed = true;
      // A new turn's narration after tool work reads as a fresh paragraph.
      if (partial && !partial.endsWith('\n')) partial += '\n\n';
    }
    partial += t;
    pushPartial();
  };

  let finalText = '';
  let totalCents = 0;
  let totalTokens = 0;
  for (let turn = 0; turn < ASK_MAX_TURNS; turn += 1) {
    setJob(projectId, { phase: 'running', message: turn === 0 ? 'Looking into it…' : `Working… (step ${turn + 1})`, turns: turn + 1 });
    turnStreamed = false;
    const askTuned = applyLaneTuning({ model: ready.model, effort: null, thinking: null }, getLaneTuning('ask'));
    const res = await callStepTurn('ask', {
      connector: ready.connector, apiKey: ready.apiKey, model: askTuned.model,
      system, tools: ASK_TOOLS, serverTools, transcript,
      effort: askTuned.effort, thinking: askTuned.thinking,
      onDelta,
    });
    if (!res.ok) {
      insertMessage({ projectId, kind: 'system', body: `The ask could not complete: ${res.error}` });
      setJob(projectId, { phase: 'failed', message: res.error, partial: null });
      return scheduleJobCleanup(projectId);
    }
    totalCents += recordSpend({ projectId, connector: ready.connector, model: res.modelUsed || ready.model, usage: res.usage, step: 'ask' });
    totalTokens += (res.usage.inputTokens || 0) + (res.usage.outputTokens || 0);
    touchLock(projectId, holder);

    if (!res.toolCalls.length) {
      finalText = res.text || finalText;
      break;
    }
    transcript.push({ role: 'assistant', text: res.text || '', toolCalls: res.toolCalls, raw: res.raw || null });
    for (const call of res.toolCalls) {
      const out = await executeAskTool({ call, containerName });
      transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: out.slice(0, 100000) });
    }
  }

  if (!finalText) {
    finalText = 'I ran out of steps before finishing — try a narrower question, or run the task as a build.';
  }
  // The answer carries what it cost (migration 527) — the whole tool loop's
  // spend, shown on the bubble and rolled into Details → Questions.
  insertMessage({ projectId, kind: 'assistant', body: finalText, costCents: totalCents, tokens: totalTokens });
  updateProject(projectId, { last_activity_at: nowIso() });
  try {
    logAudit(holder.id, 'MOCK2_ASK', 'mock2_project', projectId, { chars: question.length, cost_cents: totalCents, web_search: serverTools.length > 0 }, null);
  } catch { /* best effort */ }
  // partial cleared with the same poll that delivers the durable message.
  setJob(projectId, { phase: 'done', message: 'Answered.', partial: null });
  return scheduleJobCleanup(projectId);
}

async function executeAskTool({ call, containerName }) {
  switch (call.name) {
    case 'read_file': {
      const r = await readFileInContainer(containerName, String(call.input?.path || ''));
      return r.ok ? r.content : `error: ${r.error}`;
    }
    case 'exec_in_container': {
      const command = String(call.input?.command || '');
      const gate = askCommandAllowed(command);
      if (!gate.ok) return `refused: ${gate.reason}`;
      const r = await execInContainer(containerName, command);
      return `exit ${r.code}\n${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`;
    }
    case 'get_component': {
      const found = getPublishedComponentWithVersion(String(call.input?.key || '').trim());
      if (!found) return `error: no published component with key "${String(call.input?.key || '').slice(0, 80)}"`;
      return formatComponentForModel(found.component, found.version);
    }
    default:
      return `error: unknown tool "${call.name}"`;
  }
}
