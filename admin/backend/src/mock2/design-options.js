// Mock2 DESIGN OPTIONS — the native half (capture, model call, chat).
//
// See design-options-logic.js for WHY. In short: "it doesn't look right" is a
// report, not an instruction, and making the operator write the instruction is
// how project 44 spent three builds converging on a fix nobody had named. This
// runs one read against the LIVE screen and posts two or three layouts to
// choose from.
//
// It reuses the design review's capture wholesale: the same browser, the same
// sign-in, the same measurements. That is the point — options invented without
// looking at the screen are the generic advice the operator could have written
// themselves.
//
// NEVER a build and never a gate. Nothing here writes a file; the operator
// presses "Build this as a Quick update" on the option they want.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { captureAppScreens } from './design-review.js';
import { ensureReviewAccount, getReviewLogin } from './review-account.js';
import { callStepTurn, stepSystemPrompt } from './harness-steps.js';
import { buildRunnerReady } from './runner.js';
import { insertMessage, getOrCreateChat } from './chats.js';
import { insertLedgerEntry } from './quotas.js';
import { costCentsForUsage } from './quota-logic.js';
import { effectivePrice } from './connectors.js';
import { densityFindings, colorOnlyFindings } from './design-signals-logic.js';
import { MOCKUP_CURRENT, DESIGN_CSS_PATH } from './concept-logic.js';
import { startScreenJob, updateScreenJob, finishScreenJob } from './screen-job.js';
import {
  buildDesignOptionsPrompt, buildDesignOptionsTask, parseDesignOptions,
  diagnosisMessage, optionMessage, optionsFailureMessage, optionsStartedMessage,
} from './design-options-logic.js';

const APP_DIR = '/srv/app';

function containerSh(containerName, script, { timeoutMs = 30000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readFile(containerName, relPath) {
  const r = await containerSh(containerName, `cat '${APP_DIR}/${relPath}' 2>/dev/null`);
  return r.code === 0 ? (r.stdout || '') : '';
}

// The measurements, rendered for the model. Deterministic facts first, because
// a vision model asked to eyeball density gets it wrong and a browser does not.
function measurementBlock(capture) {
  const lines = [];
  for (const d of capture.density || []) {
    lines.push(`- ${d.path} at ${d.width}px: ${d.facts} fact(s) visible before scrolling, ${d.controls} of them interactive.`);
  }
  for (const o of capture.overflows || []) {
    lines.push(`- ${o.page} scrolls sideways by ${o.over_px}px at ${o.width}px (${o.elements.join(', ') || 'container'}).`);
  }
  for (const f of [...densityFindings(capture.density || []), ...colorOnlyFindings(capture.signals || [])]) {
    lines.push(`- ${f.detail}`);
  }
  if (!lines.length) return '';
  return `Measured from the live DOM (these are facts, not impressions):\n${lines.join('\n')}`;
}

// runDesignOptions({ project, complaint, page, initiatedBy })
//   → { ok, options, error }.  Posts to the chat; never throws.
export async function runDesignOptions({ project, complaint = '', page = '/', initiatedBy = null }) {
  const projectId = Number(project.id);
  const containerName = project.container_name;
  if (!containerName || project.lifecycle !== 'active') {
    return { ok: false, error: 'The project is not online.' };
  }
  const ready = buildRunnerReady();
  if (!ready.ok) return { ok: false, error: ready.reason || 'No model connector is ready.' };

  getOrCreateChat(projectId);
  insertMessage({ projectId, kind: 'system', body: optionsStartedMessage(page) });
  // Same progress record the screen check uses. Both drive a browser for a
  // minute or two, and both used to show nothing at all while they did.
  startScreenJob(projectId, 'options');

  // Sign in the same way the review does, so the capture is of the APP and not
  // of its sign-in page. Best effort — an unauthenticated shot is still worth
  // looking at when the complaint IS about the sign-in screen.
  let reviewLogin = null;
  try {
    updateScreenJob(projectId, { phase: 'signing-in', message: 'Signing in as the screen account…' });
    const acct = await ensureReviewAccount(project, { timeoutMs: 60000 });
    reviewLogin = acct?.login || getReviewLogin(projectId);
  } catch { reviewLogin = getReviewLogin(projectId); }

  let capture;
  try {
    updateScreenJob(projectId, { phase: 'capturing', message: `Screenshotting \`${page}\` at phone and laptop width…` });
    capture = await captureAppScreens({
      containerName,
      webPort: project.web_port || 3000,
      // The complained-about screen first; the capture adds a desktop shot for
      // the first two paths, which is exactly the pair a layout question needs.
      paths: [page],
      withAxe: false,
      reviewLogin,
    });
  } catch (e) {
    capture = { shots: [], detail: e?.message };
  }
  if (!capture.shots?.length) {
    insertMessage({ projectId, kind: 'system', body: optionsFailureMessage('no-shots') });
    finishScreenJob(projectId, { ok: false, message: 'Design options could not screenshot the app.' });
    return { ok: false, error: capture.detail || 'no screenshots' };
  }
  updateScreenJob(projectId, {
    phase: 'reading', shots: capture.shots.length,
    message: `Working out two or three ways to fix \`${page}\` from ${capture.shots.length} screenshot(s)…`,
  });

  // The approved design, so an option can name the app's own classes rather
  // than inventing a vocabulary the adherence gate will then mark as drift.
  let designNote = '';
  try {
    const designCss = await readFile(containerName, DESIGN_CSS_PATH);
    const classes = [...new Set((designCss.match(/[.][A-Za-z][A-Za-z0-9_-]{3,}/g) || []).map((c) => c.slice(1)))].slice(0, 60);
    const hasMockup = !!(await readFile(containerName, MOCKUP_CURRENT)).trim();
    if (classes.length) {
      designNote = `The approved design defines these component classes — prefer them over new ones: ${classes.join(', ')}.`
        + (hasMockup ? ' An approved mockup exists; an option that diverges from it should say so.' : '');
    }
  } catch { designNote = ''; }

  const model = String(process.env.MOCK2_DESIGN_OPTIONS_MODEL || '').trim() || ready.model;
  const res = await callStepTurn('design-options', {
    connector: ready.connector,
    apiKey: ready.apiKey,
    model,
    system: stepSystemPrompt('design-options', buildDesignOptionsPrompt(), {}),
    tools: [],
    transcript: [{
      role: 'user',
      text: buildDesignOptionsTask({
        projectName: project.name,
        complaint,
        page,
        measurements: measurementBlock(capture),
        designNote,
        shots: capture.shots,
      }),
      images: capture.shots.map((s) => ({ media_type: s.media_type, data: s.data })),
    }],
    effort: 'high',
    thinking: null,
    timeoutMs: 240000,
  });

  try {
    const u = res.usage || {};
    const cost = costCentsForUsage({
      inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
      cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
    }, effectivePrice(ready.connector.id, res.modelUsed || model));
    insertLedgerEntry({
      projectId, cycleId: null, connectorId: ready.connector.id, model: res.modelUsed || model,
      inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
      costCents: cost, wallClockMs: 0, step: 'design-options', userId: initiatedBy ?? null,
    });
  } catch (e) { console.warn('[mock2] design-options ledger write failed:', e?.message); }

  if (!res.ok) {
    insertMessage({ projectId, kind: 'system', body: optionsFailureMessage(res.error || 'the model call failed') });
    finishScreenJob(projectId, { ok: false, message: 'Design options could not finish — nothing was changed.' });
    return { ok: false, error: res.error };
  }
  const parsed = parseDesignOptions(res.text);
  if (!parsed) {
    insertMessage({ projectId, kind: 'system', body: optionsFailureMessage('unparseable') });
    finishScreenJob(projectId, { ok: false, message: 'Design options could not finish — nothing was changed.' });
    return { ok: false, error: 'unparseable options' };
  }

  // The diagnosis carries the screenshots it was read from — an option about
  // "the band above the text field" is unverifiable without the picture.
  let attachments = null;
  try {
    const { saveChatImages } = await import('./chat-images.js');
    attachments = saveChatImages(projectId, capture.shots.map((s) => ({
      data: s.data,
      media_type: s.media_type,
      name: `${String(s.path).replace(/^\/+/, '') || 'home'}-${s.width}px.jpg`,
    })));
  } catch (e) {
    console.warn('[mock2] design-options screenshot store failed:', e?.message);
  }
  insertMessage({ projectId, kind: 'system', body: diagnosisMessage(parsed, { page }), attachments });

  // ONE MESSAGE PER OPTION. An assistant message with no cycle_id already
  // carries the "Build this as a Quick update" chip, so every option gets its
  // own working button and this feature adds no new UI at all.
  parsed.options.forEach((o, i) => {
    insertMessage({ projectId, kind: 'assistant', body: optionMessage(o, i, parsed.options.length) });
  });

  finishScreenJob(projectId, {
    ok: true,
    message: `${parsed.options.length} design option(s) are in the chat — press Build this on the one you want.`,
  });
  return { ok: true, options: parsed.options, diagnosis: parsed.diagnosis };
}

export { detectDesignOptionsIntent } from './design-options-logic.js';
