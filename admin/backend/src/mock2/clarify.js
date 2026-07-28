// Mock2 REQUEST CLARIFIER — the native half (targeted capture + model call).
//
// See clarify-logic.js for WHY, and for the two-project evidence behind the
// definition of "vague". This module does three things:
//
//   1. asks the pre-pass's verdict (no extra call — the pre-pass already runs)
//   2. looks at ONLY the pages the request refers to
//   3. turns the report into two or three pressable requests
//
// THE LOOK IS DELIBERATELY NARROW. "yes, but only the pages being referred to."
// A design review screenshots four routes at two widths; this takes one or two
// shots of the screens actually named, because a question about /admin should
// not cost a capture of /login, /profile and the home page. When the request
// names no page at all, nothing is captured — and that absence is itself the
// first thing to ask about.
//
// NEVER BLOCKS. The card offers; "Build it anyway" always sends the request
// exactly as written. Every failure path here returns null, which means the
// build runs unchanged — a clarifier that could break a build by failing would
// be a gate wearing a helper's clothes.
//
// Terminology (risk R7): nothing here is named "agent".

import { callStepTurn, stepSystemPrompt } from './harness-steps.js';
import { buildRunnerReady } from './runner.js';
import { insertLedgerEntry } from './quotas.js';
import { costCentsForUsage } from './quota-logic.js';
import { effectivePrice } from './connectors.js';
import {
  buildClarifyPrompt, buildClarifyTask, parseClarifyReply, shouldClarify,
} from './clarify-logic.js';

// One or two shots, not six. The phone width only: a request vague enough to
// reach here is almost never about the laptop layout specifically, and the
// second width doubles the cost of the cheapest useful answer.
const LOOK_WIDTH = 390;
const MAX_LOOK_PAGES = 2;
const LOOK_TIMEOUT_MS = 45000;
const MODEL_TIMEOUT_MS = 60000;

// Screenshot only the named pages. Best-effort: an offline project, a missing
// browser or a slow app all degrade to reasoning from the sentence, which is
// still better than nothing and much better than a failed build.
async function lookAtPages(project, pages, { reviewLogin = null } = {}) {
  if (!pages.length || !project?.container_name || project.lifecycle !== 'active') return [];
  try {
    const { captureAppScreens } = await import('./design-review.js');
    const capture = await Promise.race([
      captureAppScreens({
        containerName: project.container_name,
        webPort: project.web_port || 3000,
        paths: pages.slice(0, MAX_LOOK_PAGES),
        withAxe: false,
        reviewLogin,
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), LOOK_TIMEOUT_MS)),
    ]);
    // captureAppScreens takes a desktop shot of the first paths too; keep only
    // the phone ones so the model gets the pages asked for and nothing else.
    return (capture?.shots || []).filter((s) => s.width === LOOK_WIDTH).slice(0, MAX_LOOK_PAGES);
  } catch (e) {
    console.warn('[mock2] clarify: could not look at the pages:', e?.message);
    return [];
  }
}

// clarifyRequest — the whole decision plus, when warranted, the expert pass.
//
// Returns null when the build should just run (the overwhelmingly common case),
// or { diagnosis, question, options, pages, reason } when there is a card to
// show. Never throws.
export async function clarifyRequest({
  project, instruction, mode = 'ask', previousUserMessage = '', previousFailed = false,
  hasImages = false, prepass = null, initiatedBy = null,
}) {
  let verdict;
  try {
    verdict = shouldClarify(instruction, { prepass, mode, previousUserMessage, previousFailed, hasImages });
  } catch (e) {
    console.warn('[mock2] clarify: verdict failed:', e?.message);
    return null;
  }
  if (!verdict.clarify) return null;

  const ready = buildRunnerReady();
  if (!ready.ok) return null;

  // The look, narrowed to what was named. Signed in the same way the review is,
  // so a screenshot of an auth-gated app is of the app and not of its gate.
  let reviewLogin = null;
  try {
    const { getReviewLogin } = await import('./review-account.js');
    reviewLogin = getReviewLogin(project.id);
  } catch { reviewLogin = null; }
  const shots = await lookAtPages(project, verdict.pages, { reviewLogin });

  const res = await Promise.race([
    callStepTurn('clarify', {
      connector: ready.connector,
      apiKey: ready.apiKey,
      model: String(process.env.MOCK2_CLARIFY_MODEL || '').trim() || ready.model,
      system: stepSystemPrompt('clarify', buildClarifyPrompt(), {}),
      tools: [],
      transcript: [{
        role: 'user',
        text: buildClarifyTask({
          instruction, appName: project?.name || 'the app', pages: verdict.pages, shots, prepass,
        }),
        images: shots.map((s) => ({ media_type: s.media_type, data: s.data })),
      }],
      effort: 'high',
      thinking: null,
      timeoutMs: 120000,
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), MODEL_TIMEOUT_MS)),
  ]);

  try {
    const u = res?.usage || {};
    if (res?.ok) {
      insertLedgerEntry({
        projectId: project.id, cycleId: null, connectorId: ready.connector.id,
        model: res.modelUsed || ready.model,
        inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
        costCents: costCentsForUsage({
          inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
          cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
        }, effectivePrice(ready.connector.id, res.modelUsed || ready.model)),
        wallClockMs: 0, step: 'clarify', userId: initiatedBy ?? null,
      });
    }
  } catch (e) { console.warn('[mock2] clarify ledger write failed:', e?.message); }

  if (!res?.ok) return null;
  const parsed = parseClarifyReply(res.text);
  // Fewer than two usable options is not a choice, and one option presented as
  // a card is the clarifier deciding for them with extra steps.
  if (!parsed) return null;
  return { ...parsed, pages: verdict.pages, looked: shots.length, reason: verdict.reason };
}

export { shouldClarify } from './clarify-logic.js';
