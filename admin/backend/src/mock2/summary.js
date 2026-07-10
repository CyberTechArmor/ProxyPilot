// Mock2 adaptive-summary orchestration (Phase M9; the brief's adaptive-summary
// section). The host/model half of the summary: on a QUALIFYING cycle it reads
// state/rules.md from the fenced container + the project's change records, runs
// the summary slot through the SAME callModelTurn the audit/classifier use, and
// writes a new versioned row into mock2_summaries — but only when a genuinely new
// material change has landed and the regenerated body actually differs.
//
// The DECISIONS are the pure summary-logic.js (the qualifying-change trigger, the
// version bump, the body-changed guard, the diff), unit-tested stub-first (risk
// R9); this module is the orchestration. It mirrors audit.js/concept.js: slot
// readiness (ADR-001 presence-of-creds), the decrypted key read ORCHESTRATOR-SIDE
// only, every container read through host.js (R3), and the spend priced on the
// summary slot + written to the ledger (R5).
//
// The summary READS rules.md (never writes it) and reads the change records — it
// does NOT take the checkout lock (ADR-004) and never touches the container's
// working tree. It is best-effort and non-fatal: a failed summary never fails the
// cycle that triggered it.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { getProject } from './projects.js';
import { containerNameForProject } from './provision.js';
import { getSlot, getConnector, decryptConnectorKey, listPrices } from './connectors.js';
import { parseCapabilities, slotAssignmentError, isCloudProvider } from './connector-logic.js';
import { insertLedgerEntry } from './quotas.js';
import { costCentsForUsage } from './quota-logic.js';
import { listChangeRecords } from './change-records.js';
import { getLatestSummary, insertSummary } from './summaries.js';
import { callModelTurn } from './model-client.js';
import {
  summaryTrigger, nextSummaryVersion, buildSummarySystemPrompt, buildSummaryTask,
  summaryBodyChanged, estimateSummaryTokens,
} from './summary-logic.js';

const APP_DIR = '/srv/app';
const RULES_PATH = 'state/rules.md';
const nowIso = () => new Date().toISOString();
const MAX_SUMMARY_INPUT_CHARS = 120000;

// ---- slot readiness (the summary slot, ADR-001 presence-of-creds) ----

// Mirrors audit.auditReady() / concept.conceptReady(). The summary slot must be
// assigned to an enabled connector that advertises 'summarize' and whose key
// decrypts orchestrator-side (a cloud provider needs a key; a local ollama may not).
export function summaryReady() {
  const slot = getSlot('summary');
  if (!slot) return { ok: false, reason: 'No summary model slot is assigned. Assign one under Model connectors.' };
  const connector = getConnector(slot.connector_id);
  if (!connector) return { ok: false, reason: 'The summary slot points at a missing connector.' };
  if (!connector.enabled) return { ok: false, reason: 'The summary connector is disabled.' };
  const capErr = slotAssignmentError(parseCapabilities(connector.capabilities), 'summary');
  if (capErr) return { ok: false, reason: capErr };
  const apiKey = decryptConnectorKey(connector);
  if (isCloudProvider(connector.provider) && !apiKey) {
    return { ok: false, reason: 'The summary connector has no decryptable API key.' };
  }
  return { ok: true, connector, model: slot.model, apiKey };
}

function effectivePrice(connectorId, model) {
  const now = nowIso();
  return listPrices(connectorId).find((p) => p.model === model && String(p.effective_at) <= now) || null;
}

function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readRules(containerName) {
  try {
    const r = await containerSh(containerName, `cat "${APP_DIR}/${RULES_PATH}" 2>/dev/null`);
    if (r.code !== 0) return '';
    return String(r.stdout || '').slice(0, MAX_SUMMARY_INPUT_CHARS);
  } catch (e) {
    console.warn('[mock2] summary rules read failed:', e?.message);
    return '';
  }
}

// maybeRegenerateSummary(projectId, opts) — the deterministic-trigger entry the
// runner (after a green build), the rule-confirmation (after rules.md grows), and
// the design approval (after inventory.json lands) call. It:
//   1) checks summaryTrigger against the change records + the last summary — a
//      non-qualifying change (pure chat / no-op) is a no-op here;
//   2) reads rules.md from the container and the change records (never chat);
//   3) generates on the summary slot and writes a NEW version only when the body
//      actually changed.
// Returns { regenerated, version?, reason }. NEVER throws — best-effort; a failure
// is logged and swallowed so it can't fail the triggering cycle.
export async function maybeRegenerateSummary(projectId, { reason = 'cycle', triggerCycleId = null } = {}) {
  try {
    const pid = Number(projectId);
    const project = getProject(pid);
    if (!project) return { regenerated: false, reason: 'project not found' };

    const records = listChangeRecords(pid);
    const last = getLatestSummary(pid);
    const trigger = summaryTrigger(records, last);
    if (!trigger.shouldRegen) {
      return { regenerated: false, reason: 'no new qualifying change' };
    }

    const ready = summaryReady();
    if (!ready.ok) return { regenerated: false, reason: ready.reason };

    const containerName = project.container_name || containerNameForProject(pid);
    const rulesMd = project.lifecycle === 'active' ? await readRules(containerName) : '';

    const res = await callModelTurn({
      connector: ready.connector, apiKey: ready.apiKey, model: ready.model,
      system: buildSummarySystemPrompt({ projectName: project.name }),
      tools: [],
      transcript: [{ role: 'user', text: buildSummaryTask({ rulesMd, records, projectName: project.name }) }],
      maxTokens: 4000,
    });
    if (!res.ok) return { regenerated: false, reason: `summary model failed: ${res.error}` };

    // Price + ledger the spend on the summary slot (R5).
    try {
      const cents = costCentsForUsage({ inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens }, effectivePrice(ready.connector.id, ready.model));
      insertLedgerEntry({ projectId: pid, cycleId: triggerCycleId, connectorId: ready.connector.id, model: ready.model, inputTokens: res.usage.inputTokens || 0, outputTokens: res.usage.outputTokens || 0, costCents: cents, wallClockMs: 0 });
    } catch (e) { console.warn('[mock2] summary ledger write failed:', e?.message); }

    const body = String(res.text || '').trim();
    if (!body) return { regenerated: false, reason: 'summary model returned an empty body' };
    if (last && !summaryBodyChanged(last.body_md, body)) {
      return { regenerated: false, reason: 'summary unchanged' };
    }

    const version = nextSummaryVersion(last);
    const row = insertSummary({ projectId: pid, version, bodyMd: body, derivedFromChangeSeq: trigger.derivedFromSeq });
    console.log(`[mock2] project ${pid} summary v${version} generated (derived from change seq ${trigger.derivedFromSeq}, trigger: ${reason})`);
    return { regenerated: true, version: row.version, reason: 'regenerated' };
  } catch (err) {
    console.warn('[mock2] summary regeneration failed:', err?.message || err);
    return { regenerated: false, reason: err?.message || String(err) };
  }
}
