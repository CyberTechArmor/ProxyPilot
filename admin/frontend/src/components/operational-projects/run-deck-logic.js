// The run deck's pure rules (RunDeck.jsx): which frames the Browser pane and the
// Activity thumbnails show, which panel a phone shows, and the activity feed built
// from the run detail. No React here, so admin/backend's node:test covers it
// (agent-run-deck.test.js).
import { ACTION_TEXT, DECK_TEXT, STALE_TEXT, eventText, grouped } from './agent-run-text.js';

export const PANELS = ['browser', 'activity', 'details'];
// The panel in the URL (&panel=), else Browser while the run is running and
// Details after it ends.
export const panelFor = (requested, active) => PANELS.includes(requested) ? requested : active ? 'browser' : 'details';

// Frames the pane may show, and the one thumbnail each step keeps. Nothing
// captured before step 1 finished is shown (the browser before its first page
// is a blank frame), and a frame identical to the last thumbnail is not attached
// again (the same page after two steps).
export const EMPTY_VIEW = Object.freeze({ live: null, thumbs: new Map(), last: null });
export function firstStepFinishedAt(steps) {
  const first = steps.find(s => s.ordinal === 1);
  return first?.finished_at ? Date.parse(first.finished_at) : null;
}
export function acceptFrame(view, frame, steps) {
  const after = firstStepFinishedAt(steps);
  if (after === null || !(Date.parse(frame.captured_at) >= after)) return view;
  const step = frame.action_count ?? 0;
  if (step < 1 || frame.png_base64 === view.last) return { ...view, live: frame };
  const thumbs = new Map(view.thumbs);
  thumbs.set(step, frame);
  return { live: frame, thumbs, last: frame.png_base64 };
}

// "3 allowed actions · 216 tokens · $0.000004625".
export function callSummary(call) {
  if (!call) return DECK_TEXT.anyAllowed;
  const noUsage = call.prompt_tokens === null && call.completion_tokens === null;
  return DECK_TEXT.callSummary(call.allowed.length, noUsage ? null : (call.prompt_tokens ?? 0) + (call.completion_tokens ?? 0), call.settled_usd ?? '?');
}

export function feedOf(data) {
  const items = [];
  const calls = new Map(data.model_calls.map(c => [c.call_id, c]));
  const stepCalls = new Set(data.steps.map(s => s.model_call_id).filter(Boolean));
  items.push({ key: 'start', at: data.run.started_at, order: 0, kind: 'system',
    title: `Run started by ${data.run.started_by.username ?? data.run.started_by.id}`,
    body: `Profile ${data.run.profile_name ?? data.run.profile_id} · guide v${data.run.guide_version_number ?? '?'}` });
  for (const e of data.events) {
    const text = eventText(e.kind);
    if (text) items.push({ key: `e${e.id}`, at: e.created_at, order: 1, kind: 'system', title: text });
  }
  for (const c of data.model_calls) if (!stepCalls.has(c.call_id)) items.push({ key: c.call_id, at: c.created_at, order: 2,
    kind: 'model', title: c.state === 'chosen' ? `The model chose ${ACTION_TEXT[c.choice] ?? c.choice}` : c.state === 'reserved'
      ? 'Asking the model to choose the next step' : `Model call ${c.state}${c.refusal_code ? `: ${c.refusal_code}` : ''}`,
    body: DECK_TEXT.modelFrom(callSummary(c)) });
  for (const s of data.steps) {
    const call = s.model_call_id ? calls.get(s.model_call_id) : null;
    items.push({ key: `s${s.ordinal}`, at: s.created_at, order: 3, kind: s.decided_by, step: s, call });
  }
  for (const a of data.approvals) {
    items.push({ key: `a${a.id}`, at: a.requested_at, order: 2, kind: 'approval', open: a.open,
      title: `Approval requested: ${ACTION_TEXT[a.action] ?? a.action}`, body: `Digest ${grouped(a.digest.slice(0, 12))} …` });
    if (a.decided_at) items.push({ key: `d${a.id}`, at: a.decided_at, order: 4, kind: 'person',
      title: `Approved by ${a.decided_by?.username ?? a.decided_by?.id}` });
    if (['stale', 'expired'].includes(a.state)) items.push({ key: `c${a.id}`, at: a.closed_at, order: 4, kind: 'system',
      title: a.state === 'expired' ? 'The approval expired unanswered.' : `The approval became stale: ${STALE_TEXT[a.stale_reason] ?? a.stale_reason}.` });
  }
  if (data.result) items.push({ key: 'result', at: data.result.created_at, order: 9, kind: 'result' });
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.order - b.order);
}
