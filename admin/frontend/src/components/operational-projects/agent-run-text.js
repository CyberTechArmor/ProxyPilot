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
  taken_over: ['Taken over', 'An operator took over the browser on the host.'],
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

// The decision a person must make when a run needs one. Takeover itself stays
// on the host operator console, and resume is a later section.
export const HELP_DECISION = {
  challenge_required: 'Decide whether a person completes the site\'s check from the host operator console, or leaves the account as it is. The agent does not answer challenges and nothing is retried.',
  taken_over: 'An operator took over this run on the host. Before another run, decide whether the account is in the state you expect. Resuming a taken-over run is not available yet.',
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
  'a5:taken_over': 'An operator took over the browser on the host.',
};
export function eventText(kind) {
  if (EVENT_TEXT[kind]) return EVENT_TEXT[kind];
  if (kind.startsWith('fenced:')) return `The run was fenced (${kind.slice(7).replaceAll('_', ' ')}).`;
  return null;
}

// The run deck: the run bar, the approval banner, the Browser pane, the
// Activity column, the Details tabs and the phone panel bar.
export const DECK_TEXT = {
  back: 'Back to runs',
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
  viewNote: 'At most one frame a second while the run is live; pixels only, never stored. Typing, clicking and takeover stay on the host.',
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
