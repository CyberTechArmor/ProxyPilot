// Mock2 "Explain this" — the native/network half. Resolves the `summary` model slot
// (the small/fast summary lane, e.g. Haiku) and asks it to rewrite a blocker /
// authorization / deviation / rule-question card in plain language for an operator.
//
// READ-ONLY and side-effect-free (task item 3): it makes ONE model call and returns
// text. It never touches a cycle, an authorization, a deviation, or the audit record
// (the route logs that an explanation was viewed; nothing here writes). A missing
// slot or a failed call returns { ok:false, error } so the caller falls back to the
// original text — the operator is never blocked on the explainer.
//
// Terminology (risk R7): the slot is `summary`; nothing here is named "agent".

import { getSlot, getConnector, decryptConnectorKey } from './connectors.js';
import { parseCapabilities, slotAssignmentError, isCloudProvider } from './connector-logic.js';
import { callStepTurn, stepSystemPrompt } from './harness-steps.js';
import {
  EXPLAIN_SYSTEM_PROMPT, buildExplainTranscript, parseExplanation,
  EXPLAIN_FOLLOWUP_SYSTEM_PROMPT, buildFollowupTranscript, parseFollowupAnswer,
} from './explain-logic.js';

// Is the summary lane usable? Mirrors concept.js's slotReady for the one slot we need,
// with an operator-readable reason when it isn't (surfaced as a graceful fallback).
function summaryReady() {
  const slot = getSlot('summary');
  if (!slot) return { ok: false, reason: 'No summary model is assigned — an admin can set one under Model connectors.' };
  const connector = getConnector(slot.connector_id);
  if (!connector) return { ok: false, reason: 'The summary model points at a missing connector.' };
  if (!connector.enabled) return { ok: false, reason: 'The summary model connector is disabled.' };
  const capErr = slotAssignmentError(parseCapabilities(connector.capabilities), 'summary');
  if (capErr) return { ok: false, reason: capErr };
  const apiKey = decryptConnectorKey(connector);
  if (isCloudProvider(connector.provider) && !apiKey) {
    return { ok: false, reason: 'The summary model connector has no usable API key.' };
  }
  return { ok: true, connector, model: slot.model, apiKey };
}

// explainCard — plain-language rewrite of a card's text via the summary lane.
// Returns { ok:true, explanation:{ what_happened, why_stopped, what_asking, if_approve,
// if_decline, risk_level, risk_why } } or { ok:false, error }. Never throws for a
// model/slot problem — those come back as { ok:false } so the UI can fall back.
export async function explainCard({ text, title = '', status = '', kind = '' }) {
  const ready = summaryReady();
  if (!ready.ok) return { ok: false, error: ready.reason };

  let res;
  try {
    res = await callStepTurn('explain-card', {
      connector: ready.connector, apiKey: ready.apiKey, model: ready.model,
      system: stepSystemPrompt('explain-card', EXPLAIN_SYSTEM_PROMPT, {}), tools: [],
      transcript: buildExplainTranscript({ text, title, status, kind }),
      timeoutMs: 240000,
    });
  } catch (err) {
    return { ok: false, error: `the explainer call failed: ${err?.message || String(err)}` };
  }
  if (!res.ok) return { ok: false, error: res.error || 'the explainer model call failed' };
  return parseExplanation(res.text);
}

// explainFollowup — answer an operator's follow-up question about an already-explained
// card, via the same summary lane. Returns { ok:true, answer } (plain text) or
// { ok:false, error }. Same read-only guarantees as explainCard: one model call, no
// state change, never throws for a model/slot problem.
export async function explainFollowup({ text, title = '', status = '', kind = '', prior = '', question }) {
  const ready = summaryReady();
  if (!ready.ok) return { ok: false, error: ready.reason };

  let res;
  try {
    res = await callStepTurn('explain-followup', {
      connector: ready.connector, apiKey: ready.apiKey, model: ready.model,
      system: stepSystemPrompt('explain-followup', EXPLAIN_FOLLOWUP_SYSTEM_PROMPT, {}), tools: [],
      transcript: buildFollowupTranscript({ text, title, status, kind, prior, question }),
      timeoutMs: 240000,
    });
  } catch (err) {
    return { ok: false, error: `the explainer call failed: ${err?.message || String(err)}` };
  }
  if (!res.ok) return { ok: false, error: res.error || 'the explainer model call failed' };
  return parseFollowupAnswer(res.text);
}
