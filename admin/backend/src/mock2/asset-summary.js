// Document-asset summary pass — the async half of the reference-file
// feature. After a text file (or the files of a zip) lands in the asset
// library, this folds each one into a short brief + "where to find things"
// index via the cheap `summary` slot. Prompts then carry ONLY that brief
// (project-assets-logic.buildAssetContext); the full content sits in the
// project container at state/assets/<path> for on-demand reads.
//
// Everything here is best-effort: no summary model configured, a failed
// call, or a deleted asset all leave `body` null, which the context
// renders as "(summary pending — read the file if needed)". Uploads never
// block on this pass.

import { getSlot, getConnector, decryptConnectorKey, effectivePrice } from './connectors.js';
import { parseCapabilities, slotAssignmentError, isCloudProvider } from './connector-logic.js';
import { callStepTurn } from './harness-steps.js';
import { insertLedgerEntry } from './quotas.js';
import { costCentsForUsage } from './quota-logic.js';
import { getAssetRow, readAssetText, setDocumentSummary } from './project-assets.js';
import { buildDocSummaryPrompt, DOC_SUMMARY_MAX_CHARS, DOC_SUMMARY_SYSTEM_PROMPT } from './project-assets-logic.js';
import { stepSystemPrompt } from './harness-steps.js';

// Same shape as explain.js's summaryReady (the canonical slot-resolution
// pattern — deliberately copied, not shared, per the existing convention).
function summaryReady() {
  const slot = getSlot('summary');
  if (!slot) return { ok: false, reason: 'no summary model assigned' };
  const connector = getConnector(slot.connector_id);
  if (!connector) return { ok: false, reason: 'summary connector missing' };
  if (!connector.enabled) return { ok: false, reason: 'summary connector disabled' };
  const capErr = slotAssignmentError(parseCapabilities(connector.capabilities), 'summary');
  if (capErr) return { ok: false, reason: capErr };
  const apiKey = decryptConnectorKey(connector);
  if (isCloudProvider(connector.provider) && !apiKey) {
    return { ok: false, reason: 'summary connector has no usable key' };
  }
  return { ok: true, connector, model: slot.model, apiKey };
}

// Summarize ONE document asset; returns true when a brief was stored.
export async function summarizeDocumentAsset({ projectId, assetId }) {
  const ready = summaryReady();
  if (!ready.ok) return false;
  const row = getAssetRow(projectId, assetId);
  if (!row || row.kind !== 'document') return false;
  const text = readAssetText(projectId, assetId);
  if (text == null) return false;

  const res = await callStepTurn('doc-summary', {
    connector: ready.connector, apiKey: ready.apiKey, model: ready.model,
    system: stepSystemPrompt('doc-summary', DOC_SUMMARY_SYSTEM_PROMPT, {}),
    tools: [],
    transcript: [{ role: 'user', text: buildDocSummaryPrompt({ name: row.name, text }) }],
    maxTokens: 1500, effort: 'low', thinking: 'off', timeoutMs: 120000,
  });
  if (!res.ok || !String(res.text || '').trim()) return false;
  setDocumentSummary(projectId, assetId, String(res.text).trim().slice(0, DOC_SUMMARY_MAX_CHARS));
  try {
    const u = res.usage || {};
    const cents = costCentsForUsage({
      inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
      cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
    }, effectivePrice(ready.connector.id, res.modelUsed || ready.model));
    insertLedgerEntry({
      projectId, cycleId: null, connectorId: ready.connector.id, model: res.modelUsed || ready.model,
      inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costCents: cents,
      wallClockMs: 0, step: 'doc-summary',
    });
  } catch (e) { console.warn('[mock2] doc-summary ledger write failed:', e?.message); }
  return true;
}

// Fire-and-forget serial queue for a batch of freshly-uploaded documents
// (one at a time so an archive of 200 files doesn't fan out 200 concurrent
// model calls). Callers do NOT await this.
export function queueDocumentSummaries(projectId, assetIds) {
  const ids = (Array.isArray(assetIds) ? assetIds : []).filter((n) => Number(n) > 0);
  if (!ids.length) return;
  (async () => {
    for (const id of ids) {
      try { await summarizeDocumentAsset({ projectId, assetId: id }); }
      catch (e) { console.warn('[mock2] doc summary failed (advisory):', e?.message); }
    }
  })();
}

// Self-heal for summaries that never landed: the upload-time queue is
// fire-and-forget and in-memory, so a backend restart (an update mid-upload)
// or a then-unconfigured summary slot leaves documents summary-less forever
// while the panel implies work in progress. Whenever the asset list is READ,
// re-queue any document without a summary — debounced per project so a
// permanently failing slot is retried at most every 10 minutes.
const backfillAt = new Map();
const BACKFILL_EVERY_MS = 10 * 60 * 1000;
export function maybeBackfillDocumentSummaries(projectId, assets) {
  const missing = (Array.isArray(assets) ? assets : [])
    .filter((a) => a && a.kind === 'document' && !String(a.body || '').trim())
    .map((a) => a.id);
  if (!missing.length) return;
  const key = Number(projectId);
  const last = backfillAt.get(key) || 0;
  if (Date.now() - last < BACKFILL_EVERY_MS) return;
  backfillAt.set(key, Date.now());
  queueDocumentSummaries(projectId, missing);
}
