// Mock2 escalation consult — the native/network half (cost-truth Part 5.2). Runs the
// bounded, advisory-only "second opinion" on Fable 5: a SINGLE tool-free model call over
// a compiled context digest, capped input (~30k) + output (~4k) ≈ $0.50. It never takes
// over the build, never switches the build lane, and its result is attached to the halt
// card as advice + pre-filled resume text. Cost logs as its own request segment.
//
// Read-only w.r.t. the build: it does not resume, grant, or gate anything. The pure
// caps/triggers/digest live in consult-logic.js; this half resolves the Fable 5
// connector, makes the call, prices it, and stores the row.
//
// Terminology (risk R7): nothing here is named "agent".

import { getSlot, getConnector, decryptConnectorKey, effectivePrice } from './connectors.js';
import { parseCapabilities, isCloudProvider } from './connector-logic.js';
import { costCentsForUsage, defaultModelPrice } from './quota-logic.js';
import { callModelTurn } from './model-client.js';
import {
  CONSULT_MODEL, CONSULT_SYSTEM_PROMPT, CONSULT_OUTPUT_TOKEN_CAP,
  buildConsultDigest, parseConsultOutput,
} from './consult-logic.js';
import { insertConsult, publicConsultShape } from './consults.js';

// Resolve a connector that can run Fable 5. Prefer the AUDIT slot (recommended to be the
// Fable 5 lane), fall back to build_runner — always with the model FORCED to
// CONSULT_MODEL (the consult never runs on the build lane's model). Returns
// { ok, connector, apiKey } or { ok:false, reason }.
function consultConnector() {
  for (const slotName of ['audit', 'build_runner']) {
    const slot = getSlot(slotName);
    if (!slot) continue;
    const connector = getConnector(slot.connector_id);
    if (!connector || !connector.enabled) continue;
    // The consult needs a chat-capable connector; both audit + build_runner qualify.
    parseCapabilities(connector.capabilities);
    const apiKey = decryptConnectorKey(connector);
    if (isCloudProvider(connector.provider) && !apiKey) continue;
    return { ok: true, connector, apiKey };
  }
  return { ok: false, reason: 'No connector is available to run a Fable 5 second opinion (assign the audit or build lane to an Anthropic connector).' };
}

// runConsult — compile the digest, make the one Fable 5 call, price it, store the row.
// digestParts: { task, haltReason, lastErrors, gateOutput, fileExcerpts }. Returns
// { ok:true, consult } (public shape) or { ok:false, error }. Never throws for a
// model/slot problem — advisory, non-blocking.
export async function runConsult({ projectId, requestId = null, cycleId = null, trigger, digestParts = {}, requestedBy = null }) {
  const ready = consultConnector();
  if (!ready.ok) return { ok: false, error: ready.reason };

  const { text: digest } = buildConsultDigest(digestParts);
  let res;
  try {
    res = await callModelTurn({
      connector: ready.connector, apiKey: ready.apiKey, model: CONSULT_MODEL,
      system: CONSULT_SYSTEM_PROMPT, tools: [],
      transcript: [{ role: 'user', text: digest }],
      maxTokens: CONSULT_OUTPUT_TOKEN_CAP,
    });
  } catch (err) {
    return { ok: false, error: `the consult call failed: ${err?.message || String(err)}` };
  }
  if (!res.ok) return { ok: false, error: res.error || 'the consult model call failed' };
  const parsed = parseConsultOutput(res.text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const u = res.usage || {};
  const price = effectivePrice(ready.connector.id, CONSULT_MODEL) || defaultModelPrice(CONSULT_MODEL);
  const costCents = costCentsForUsage({
    inputTokens: u.inputTokens, outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
  }, price);

  const row = insertConsult({
    projectId, requestId, cycleId, trigger, model: CONSULT_MODEL,
    inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costCents,
    diagnosis: parsed.consult.diagnosis, paths: parsed.consult.paths, suggestedResume: parsed.consult.suggested_resume,
    requestedBy,
  });
  return { ok: true, consult: publicConsultShape(row) };
}
