// A6 words for the typed run state the server returns. The server sends codes
// only (states, result classes, actions, rule names, claim keys, refusal codes);
// every sentence a person reads about an agent run lives here.

export const STATE_TEXT = {
  prepared: 'Preparing', starting: 'Starting the browser', running: 'Running', cancelling: 'Stopping',
  cancelled: 'Stopped', blocked: 'Blocked', failed: 'Failed', completed: 'Completed',
};
export const ACTIVE_STATES = ['prepared', 'starting', 'running', 'cancelling'];

export const ACTION_TEXT = {
  open_landing: 'Open the landing page', open_login: 'Open the sign-in dialog',
  submit_bound_fixture: 'Submit the bound credential', read_workspace: 'Read the workspace',
  read_session: 'Read the session', read_files: 'Read the files', sign_out: 'Sign out',
};
export const RULE_TEXT = {
  start: 'the start rule', finish: 'the finish rule', verify_account: 'the verify-account rule',
  single_choice: 'the only action the rules leave open',
};
export const CLAIM_TEXT = {
  authenticated: 'Signed in', as_bound_account: 'As the bound account', sample_present: 'Sample file present',
  signed_out: 'Signed out', outcome: 'Sign-in outcome', login_requests: 'Sign-in requests',
};

// [short label, what it means]
export const RESULT_TEXT = {
  verified_account: ['Signed in and verified', 'After the approved submit, the runner\'s own session read named the bound account.'],
  credential_rejected: ['Credential rejected', 'The site refused the bound credential. The host operator checks or rotates the synthetic account before another run.'],
  rate_limited: ['Rate limited', 'The site is limiting sign-ins. Wait before another run; nothing is retried automatically.'],
  challenge_required: ['Challenge required', 'The site asked for an extra check that the agent does not answer.'],
  unexpected_origin: ['Unexpected origin', 'The sign-in led outside the pinned site, so the run stopped.'],
  timeout: ['Timed out', 'The sign-in did not answer in time.'],
  unverified_account: ['Account not verified', 'The submit happened, but the session read did not name the bound account.'],
  submit_failed: ['Submit failed', 'The submit step failed. It is never retried automatically.'],
  cancelled: ['Stopped', 'A person stopped the run.'],
  taken_over: ['Taken over', 'A person took over the browser; the agent stopped and never resumes in that browser.'],
  interrupted: ['Interrupted', 'The coordinator restarted while the run was active. The run was fenced and nothing was resumed.'],
  uncertain_step: ['Uncertain step', 'A browser step may or may not have taken effect.'],
  model_uncertain: ['Uncertain model call', 'A model call may or may not have been answered and charged.'],
  approval_stale: ['Approval stale', 'The approval no longer matched the run, binding, guide or policy. The submit did not happen.'],
  approval_timeout: ['Approval timed out', 'Nobody approved the submit within 15 minutes. The submit did not happen.'],
  model_choice_invalid: ['Model choice refused', 'The model answered outside the actions the rules allowed.'],
  guide_not_shareable: ['Guide not shareable', 'The owner has not consented to sending this guide to the model provider.'],
  model_unavailable: ['No model allowed', 'The guide\'s rules name no model, but a step needed one.'],
  model_call_limit: ['Model call limit', 'The rules\' model call limit was reached.'],
  budget_exhausted: ['Budget exhausted', 'The project\'s token or spending limit was reached before the provider call.'],
  price_unknown: ['Price unknown', 'The broker has no price for the model, so it made no call.'],
  usage_unknown: ['Usage unknown', 'The provider reply carried no usage, so the call was not trusted.'],
  provider_error: ['Provider error', 'The model provider refused or failed the call.'],
  prompt_too_large: ['Prompt too large', 'The guide is too large to send to the model.'],
  model_refused: ['Model call refused', 'The supervisor refused the model call.'],
  stale_configuration: ['Configuration changed', 'The profile, guide, site or policy changed after the run started.'],
  binding_changed: ['Binding changed', 'The credential binding was rotated or revoked after the run started.'],
  action_not_permitted: ['Action not permitted', 'The next required action is outside the profile\'s permitted actions.'],
  action_limit: ['Action limit', 'The project\'s browser action limit was reached.'],
  step_limit: ['Step limit', 'The rules\' step limit was reached.'],
  no_allowed_action: ['No allowed action', 'The rules leave no action to take.'],
  action_failed: ['Start step failed', 'A required start step failed.'],
  step_refused: ['Step refused', 'The worker boundary refused the next step.'],
  lease_expired: ['Lease expired', 'The worker lease expired.'],
  attempt_lost: ['Attempt lost', 'The worker attempt was lost or fenced.'],
  deadline: ['Deadline reached', 'The project\'s run time limit was reached.'],
  launch_failed: ['Launch failed', 'The worker could not be started.'],
  broker_unavailable: ['Broker unavailable', 'The credential broker was unreachable.'],
};
export const resultLabel = code => RESULT_TEXT[code]?.[0] ?? code;

// The decision a person must make when a run needs one (A7: decide it on the
// run, then resume it as a new linked run if it should continue).
export const HELP_DECISION = {
  challenge_required: 'The site asked for an extra check the agent does not answer. Take over a later run to complete it yourself, or leave the account as it is; nothing is retried.',
  taken_over: 'A person took over this run. Decide below whether the account is in the state you expect; you can then resume it as a new run.',
  timeout: 'The sign-in did not answer in time, so it may or may not have happened. Check the account on the site and record below whether it signed in; the profile cannot start again until someone does.',
  interrupted: 'Check the account on the site before you start another run: the coordinator restarted, the run was fenced and nothing was replayed.',
  uncertain_step: 'A browser step may or may not have taken effect. Check the account on the site before you start another run; the step is never replayed.',
  model_uncertain: 'A model call may or may not have been answered and charged. Check the provider spend before you start another run; the call is never re-sent.',
};

export const STALE_TEXT = {
  run_stopping: 'the run was stopping', run_not_running: 'the run is no longer running',
  binding_revoked: 'the credential binding was revoked', state_changed: 'the run, its binding, the guide or the policy changed',
  coordinator_restart: 'the coordinator restarted',
};

export const EVENT_TEXT = {
  running: 'The browser started for this attempt.',
  recovery_fenced: 'Fenced after a coordinator restart.',
  'a5:taken_over': 'The agent stopped: a person took over the browser.',
  'a7:resumed': 'Started as a resume of an earlier run, from step 1 in a fresh browser.',
  'a7:takeover_requested': 'A person asked to take over; the agent stops before its next step.',
  'a7:takeover_holding': 'A person has control of the browser.',
  'a7:takeover_ended': 'The person gave the browser back; the run ends.',
  'a7:takeover_refused': 'The browser could not be handed over; the run stopped.',
};
export function eventText(kind) {
  if (EVENT_TEXT[kind]) return EVENT_TEXT[kind];
  if (kind.startsWith('fenced:')) return `The run was fenced (${kind.slice(7).replaceAll('_', ' ')}).`;
  if (kind.startsWith('a7:practice:')) return `Practice run: the demo was set to "${FIXTURE_TEXT[kind.slice(12)]?.[0] ?? kind.slice(12)}".`;
  if (kind.startsWith('a7:reconciled:')) {
    const [, , what, decision] = kind.split(':');
    return `A person recorded ${RECONCILE_TEXT.kind[what] ?? what}: ${RECONCILE_TEXT.decision[decision] ?? decision}.`;
  }
  return null;
}

// A7 practice: the demo's fixture modes, [label, what the demo does, expected result].
export const FIXTURE_TEXT = {
  normal: ['Normal sign-in', 'The demo signs the synthetic account in as usual.', 'Signed in and verified'],
  expired: ['Expired credential', 'The demo refuses the synthetic account\'s password as expired.', 'Credential rejected'],
  locked: ['Locked account', 'The demo answers that sign-ins are being limited.', 'Rate limited'],
  challenge: ['Extra check', 'The demo asks for an extra check after the password.', 'Challenge required'],
  redirect: ['Unexpected redirect', 'The demo sends the browser to another origin after the password.', 'Unexpected origin'],
  slow: ['Slow sign-in', 'The demo takes longer to answer than the agent waits.', 'Timed out'],
};

// A7 decision 3: a person's typed decision about each uncertain item.
export const RECONCILE_TEXT = {
  kind: { write: 'whether a sign-in or sign-out happened', read: 'whether a step happened',
    model_call: 'whether a model call was made', run: 'that the help request was seen' },
  decision: { happened: 'it happened', did_not_happen: 'it did not happen', unknown: 'not known yet',
    acknowledged: 'acknowledged' },
  title: item => item.kind === 'model_call' ? `Model call ${String(item.call_id ?? '').slice(0, 8)}`
    : item.kind === 'run' ? 'This help request' : `Step ${item.ordinal}: ${ACTION_TEXT[item.action] ?? item.action}`,
  question: item => ({
    write: 'Did it take effect on the site? Check the account there first. Until someone records that it happened or did not, this profile cannot start again.',
    read: 'Did this step take effect? It is never replayed.',
    model_call: 'Was this model call answered and charged? Check the provider spend. It is never re-sent.',
    run: 'Record that you have seen what this run needed.',
  })[item.kind],
  reason: reason => ({ timeout: 'the sign-in timed out', uncertain: 'the step\'s outcome is unknown',
    SIGN_OUT_UNCONFIRMED: 'the sign-out could not be confirmed' })[reason]
    ?? RESULT_TEXT[reason]?.[0] ?? String(reason ?? '').replaceAll('_', ' ').toLowerCase(),
  heading: 'Decisions for a person',
  note: 'Each decision is recorded with your name and time; nothing is re-sent. Deciding needs your own confirmation once in this session.',
  by: (who, at) => `Recorded by ${who} · ${at}`,
  supervisor: item => {
    const evidence = item.supervisor_record;
    if (!evidence || evidence.status === 'unavailable') return 'The supervisor record is unavailable.';
    if (evidence.status === 'missing') return 'The supervisor has no matching record of this step.';
    const r = evidence.record;
    return `Supervisor recorded: ${r.state}. Reserved at ${r.at}${r.latency_ms != null ? `; command latency ${r.latency_ms} ms` : ''}${r.error ? `; ${r.error}` : ''}.`;
  },
  supervisorNote: 'A completed command can still have an uncertain site outcome. Check the site before deciding.',
};

// A7 decision 5: the rule-based review, one sentence per code.
export const CRITIQUE_TEXT = {
  verified_account: () => 'The run signed in and verified the bound account.',
  rule_steps: i => `${i.rule_steps} of ${i.steps} steps were decided by the guide's rules, without the model.`,
  approval_used: i => `The submit ran under ${i.count === 1 ? 'a person\'s approval' : `${i.count} approvals`}.`,
  no_uncertain_steps: () => 'Every step has a known outcome.',
  signed_out: () => 'The browser signed out before it was torn down.',
  receipt_verified: () => 'The teardown receipt verified against the host key.',
  practice_matched: i => `Practice: "${FIXTURE_TEXT[i.fixture_mode]?.[0] ?? i.fixture_mode}" produced the expected result (${RESULT_TEXT[i.expected]?.[0] ?? i.expected}).`,
  result: i => `The run ended ${STATE_TEXT[i.final_state]?.toLowerCase() ?? i.final_state}: ${RESULT_TEXT[i.result_class]?.[0] ?? i.result_class}.`,
  approval_expired: () => 'An approval expired unanswered.',
  approval_stale: i => `An approval became stale${i.stale_reason ? `: ${STALE_TEXT[i.stale_reason] ?? i.stale_reason}` : ''}.`,
  step_failed: i => `Step ${i.ordinal} (${ACTION_TEXT[i.action] ?? i.action}) failed${i.error_code ? ` with ${i.error_code}` : ''}.`,
  uncertain_steps: i => `${i.count === 1 ? 'One step' : `${i.count} steps`} may or may not have taken effect.`,
  model_call_uncertain: () => 'A model call may or may not have been answered and charged.',
  model_call_refused: i => `A model call was refused${i.refusal_code ? ` (${i.refusal_code})` : ''}.`,
  sign_out_failed: () => 'Signing out failed.',
  practice_mismatch: i => `Practice: "${FIXTURE_TEXT[i.fixture_mode]?.[0] ?? i.fixture_mode}" should produce ${RESULT_TEXT[i.expected]?.[0] ?? i.expected}, but the run ended ${RESULT_TEXT[i.actual]?.[0] ?? i.actual}.`,
  still_running: () => 'The run has not ended yet.',
  slow_step: i => `Step ${i.ordinal} (${ACTION_TEXT[i.action] ?? i.action}) took ${i.seconds} s.`,
  model_cost: i => `${i.calls} model ${i.calls === 1 ? 'call' : 'calls'}, ${i.tokens} tokens${i.usd.length ? `, $${i.usd.join(' + $')}` : ''}.`,
  takeover: i => `${i.user ?? 'A person'} took over${i.seconds != null ? ` for ${i.seconds} s` : ''}: ${i.inputs?.key ?? 0} keys, ${i.inputs?.click ?? 0} clicks, ${i.inputs?.scroll ?? 0} scrolls (what was typed is never recorded).`,
  resumed_from: i => `This run resumes run ${String(i.run_id).slice(0, 8)}.`,
  reconcile_writes: () => 'A sign-in or sign-out still needs a person\'s decision before the profile runs again.',
  reconcile_open: () => 'Some items still need a person\'s decision.',
};
export const critiqueText = item => CRITIQUE_TEXT[item.code]?.(item) ?? item.code.replaceAll('_', ' ');

// The model's summary of a finished run (decision 5), by its state.
export const SUMMARY_TEXT = {
  heading: 'Model summary',
  written: 'Written by the model from this run\'s typed facts only (no page, guide or credential). It can be wrong: check it against the activity.',
  reserved: 'The summary is being written.',
  uncertain: 'It is not known whether the summary request reached the model provider. It is not sent again.',
  refused: code => `No summary: the request was refused (${code ?? 'unknown'}).`,
  none: 'No model summary for this run. The owner can allow summaries for this profile in Agents.',
  usage: (p, c, usd) => `${p ?? 0} + ${c ?? 0} tokens · $${usd ?? '—'}`,
};

// A7 live view and takeover in the Browser pane.
export const LIVE_TEXT = {
  state: { connecting: 'Connecting to the live browser…', live: '', unavailable: 'Live video is not available.',
    failed: 'The live video could not connect.', closed: 'The live view ended.' },
  fallback: reason => `Live video is not available${reason ? ` (${reason})` : ''}; still frames are shown instead.`,
  notSetUp: 'Live video is not set up on this installation; still frames are shown.',
  reason: { timeout: 'it did not connect in time', webrtc_failed: 'the video connection failed', closed: 'the connection closed',
    viewer_lost: 'the connection was lost', access_ended: 'your access or session ended', attempt_ended: 'the browser was torn down',
    rate_limited: 'too many messages', disconnected: 'the browser disconnected', idle: 'it was idle' },
  retry: 'Try live video again',
  videoLabel: 'Live video of the agent\'s browser',
  videoArea: 'Live browser (view only)',
  controlArea: 'Live browser: you have control',
  keyboard: 'Keyboard',
  keyboardField: 'Type into the live browser',
  controlHint: 'You have the mouse and keyboard. Leaving this page gives the browser back and ends the run.',
  takeover: 'Take over',
  takeoverHint: 'Stop the agent and control this browser yourself.',
  takeoverWait: 'Take over is available once the live video is playing.',
  giveBack: 'Give back and end run',
  holder: (who, since) => `${who} has control since ${since}.`,
  holderMe: 'You have control of this browser.',
  confirmTitle: 'Take over this run?',
  confirmBody: [
    'The agent stops before its next step and never continues in this browser.',
    'You get the mouse and keyboard of the live browser. What you type is never recorded: only how many keys, clicks and scrolls.',
    'When you give it back, or leave this page, the run ends and needs a person; you can resume it as a new run.',
  ],
  confirm: 'Take over',
  endTitle: 'Give the browser back?',
  endBody: 'The run ends now (taken over) with its verified teardown receipt. It then needs a person: decide what happened, and resume it as a new run if it should continue.',
  end: 'Give back and end run',
  cancel: 'Cancel',
  taken: 'You have control. The agent has stopped.',
  ended: 'You gave the browser back. The run is ending.',
};

// A7 run origin, resume and practice start.
export const ORIGIN_TEXT = {
  practice: mode => `Practice: ${FIXTURE_TEXT[mode]?.[0] ?? mode}`,
  expected: result => `Expected: ${RESULT_TEXT[result]?.[0] ?? result}`,
  resumedFrom: id => `Resumes run ${String(id).slice(0, 8)}`,
  resumedAs: id => `Resumed as run ${String(id).slice(0, 8)}`,
  resume: 'Resume as a new run',
  resumeHint: 'Starts a new run linked to this one, pinned to the same profile, guide, binding and policy, from step 1 in a fresh browser. It asks for its own approval.',
  resumeUnavailable: reason => `Resume is not available: ${reason}`,
  practiceStart: 'Practice run…',
  practiceTitle: 'Start a practice run',
  practiceBody: 'A practice run puts the demo into one behaviour for the synthetic account, so you can see how the agent handles it. It runs alone: no other run starts until it ends, and the demo goes back to normal afterwards.',
  practiceMode: 'Demo behaviour',
  practiceGo: 'Start practice run',
  practiceUnavailable: 'A practice run is not available:',
  practiceSameReasons: 'the reasons Start is not available, above;',
}

// The run deck: the run bar, the approval banner, the Browser pane, the
// Activity column, the Details tabs and the phone panel bar.
export const DECK_TEXT = {
  back: 'Back to run history',
  stop: 'Stop run',
  stopShort: 'Stop',
  stopHint: 'Stop fences the run at once; nothing more happens, and the verified teardown receipt is collected.',
  stopRetry: 'The run is fenced and stopping. Stop again retries collecting the verified teardown receipt; the run never resumes.',
  stopUnavailable: reason => `Stop is not available: ${reason}`,
  approvalNeeded: 'Approval needed',
  approvalTitle: action => `Approval needed: ${action}`,
  approvalLine: (at, digest) => `Requested ${at} · digest ${digest} … · approve with sudo and the digest`,
  review: 'Review and approve',
  reviewShort: 'Review',
  browser: 'Browser',
  live: 'LIVE',
  paused: 'Paused',
  ended: 'Ended',
  watch: 'Watch live (view only)',
  enlarge: 'Enlarge the browser frame',
  starting: 'Starting the browser…',
  firstFrame: 'Waiting for the first frame…',
  watchingPaused: 'Watching is paused.',
  noBrowser: 'No live browser.',
  viewUnavailable: reason => `Live view is not available: ${reason}`,
  liveAlt: step => `Live browser frame at step ${step}`,
  lastAlt: step => `Last browser frame at step ${step}`,
  thumbAlt: step => `Browser frame at step ${step}; open it larger`,
  captionLive: (step, action, at) => `At step ${step} · ${action} · captured ${at}`,
  captionEnded: step => `Last frame · at step ${step}`,
  viewNote: 'Still frames: at most one a second while the run is live; pixels only, never stored.',
  liveNote: 'Live video through the relay; never stored. Anyone with run access can watch; one person at a time can take over.',
  activity: 'Activity',
  events: n => `${n} ${n === 1 ? 'event' : 'events'} · newest last`,
  activityNote: 'Typed progress from the durable record: each step, who decided it (a rule or the model), the claims kept and any error. Page text never reaches this view.',
  pausedUntilApproval: 'The agent is paused until approval',
  jump: n => `Jump to latest (${n} new)`,
  details: 'Details',
  result: 'Result',
  modelCalls: n => `Model calls (${n})`,
  approvals: n => `Approvals (${n})`,
  pins: 'Pins',
  reviewTab: 'Review',
  noResult: 'No result yet: it appears here when the run ends.',
  refresh: 'Refresh run',
  panels: 'Run panels',
  runMeta: ({ by, at, step, max, guide, binding }) =>
    [`Started by ${by}`, at, `step ${step}${max ? ` of at most ${max}` : ''}`, `guide v${guide}`, `binding ${binding}`].join(' · '),
  // A model call in one line; the full allowed list is in Details → Model calls.
  callSummary: (allowed, tokens, usd) => `${allowed} allowed ${allowed === 1 ? 'action' : 'actions'}${tokens === null ? '' : ` · ${tokens} tokens · $${usd}`}`,
  anyAllowed: 'the allowed actions',
  modelFrom: summary => `From ${summary}`,
};
// The kind chip on each activity item.
export const KIND_TEXT = { system: 'System', rule: 'Rule', model: 'Model', approval: 'Approval', person: 'Person', result: 'Result' };

export const shortId = id => (id ? String(id).slice(0, 8) : '—');
export const when = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};
// Time of day alone today, else the date and time.
export const whenShort = iso => {
  const d = new Date(iso ?? '');
  return !Number.isNaN(d.getTime()) && d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : when(iso);
};
// Time of day only, for the activity feed and the frame caption.
export const clock = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
};
// Groups of four so a person can compare a digest by eye.
export const grouped = hex => String(hex ?? '').replace(/(.{4})/g, '$1 ').trim();
