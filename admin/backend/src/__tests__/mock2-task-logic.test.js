// Mock2 task continuity — the pure decision layer (task-logic.js): task keys,
// redaction, the cycle → task status table, message routing ("continue" /
// "stop" / "only explain") before the model gets its tools, crash evidence,
// handoff parsing, and the exact text of task.json / handoff.md / the resume
// recovery section. Stub-first (risk R9): imports ONLY native-free modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TASK_INTENTS, TASK_STATUSES, UNFINISHED_TASK_STATUSES, CONTINUATION_STALE_DAYS, RECOVERY_SECTION_MAX,
  MAX_UNCERTAIN, MAX_GUIDANCE_CHARS, TASK_AUTHORITY_NOTE,
  slugifyGoal, makeTaskKey, isValidTaskKey, sanitizeTaskText, hydrateTask, buildTaskStatusFromCycle,
  classifyContinuationMessage, pickContinuationTask, pickCurrentTask, resolveTaskRoute, uncertainFromEvents,
  parseHandoffSections, appendStep, renderTaskJson, renderTaskHandoffMd, buildRecoverySection,
  buildInvestigationContinuation, routedNote, publicTaskShape,
} from '../mock2/task-logic.js';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

function task(over = {}) {
  return {
    id: 12, key: 't12-add-invoice-export', projectId: 3, intent: 'build', status: 'interrupted',
    goal: 'Add invoice export', requestId: 34, lastCycleId: 88, authorizedBy: 4242,
    authorizedAt: '2026-10-21T10:00:00.000Z', folder: '/srv/app', branch: 'main',
    lastVerifiedStep: 'Checkpoint 1a2b3c4 committed', nextStep: 'Resume from the last checkpoint',
    completedSteps: [{ step: 'Build started', at: '2026-10-21T10:00:00.000Z' }],
    checks: [{ key: 'typecheck', status: 'passed' }], blockers: [], remaining: ['Run checks', 'Review changes'],
    uncertain: ['A deploy was in progress when the build stopped — check whether the app serves the new version before deploying again'],
    context: null, revision: 7, filesRevision: 6,
    createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:05:00.000Z', finishedAt: null,
    ...over,
  };
}

// ---- module shape ----

test('the module is pure: it imports only harness-safety and the convention module', () => {
  const src = readFileSync(new URL('../mock2/task-logic.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./continuity-convention.js', './harness-safety.js']);
  assert.doesNotMatch(src, /\bimport\(/, 'no dynamic imports either');
});

test('constants: intents, statuses, unfinished set, stale window', () => {
  assert.deepEqual([...TASK_INTENTS], ['build', 'investigation']);
  assert.deepEqual([...TASK_STATUSES], ['active', 'interrupted', 'blocked', 'failed', 'completed', 'stopped']);
  assert.deepEqual([...UNFINISHED_TASK_STATUSES], ['active', 'interrupted', 'blocked', 'failed']);
  assert.equal(CONTINUATION_STALE_DAYS, 7);
  assert.ok(Object.isFrozen(TASK_STATUSES) && Object.isFrozen(UNFINISHED_TASK_STATUSES));
});

// ---- key / slug ----

test('slugifyGoal: lowercase, runs of non [a-z0-9] → "-", trimmed, max 40, fallback "task"', () => {
  assert.equal(slugifyGoal('Add invoice export'), 'add-invoice-export');
  assert.equal(slugifyGoal('  Fix: the "Save" button!!  '), 'fix-the-save-button');
  assert.equal(slugifyGoal('--Hello---World--'), 'hello-world');
  assert.equal(slugifyGoal(''), 'task');
  assert.equal(slugifyGoal(null), 'task');
  assert.equal(slugifyGoal('¿¡ ✨ !!'), 'task');
  assert.equal(slugifyGoal('Ünïcödé café'), 'n-c-d-caf');
  // Cut at 40, then the trailing '-' left by the cut is trimmed.
  const cutAtDash = `${'a'.repeat(39)} bcd`;
  assert.equal(slugifyGoal(cutAtDash), 'a'.repeat(39));
  const long = 'Build the complete customer onboarding flow with email verification and SSO';
  const s = slugifyGoal(long);
  assert.ok(s.length <= 40);
  assert.ok(!s.endsWith('-') && !s.startsWith('-'));
  assert.equal(s, 'build-the-complete-customer-onboarding-f');
});

test('slugifyGoal redacts first: a secret in the goal never becomes a folder name', () => {
  const slug = slugifyGoal('Use key sk-ant-abcdefghijklmnopqrstuvwx for the API');
  assert.doesNotMatch(slug, /abcdefghij/);
  assert.match(slug, /redacted/);
});

test('makeTaskKey / isValidTaskKey: t<id>-<slug>, every generated key valid, bad keys rejected', () => {
  assert.equal(makeTaskKey(12, 'Add invoice export'), 't12-add-invoice-export');
  assert.equal(makeTaskKey(7, ''), 't7-task');
  const goals = ['Add invoice export', '', '!!!', 'a', 'x'.repeat(200), `${'a'.repeat(39)}-b`, 'Ä-ö-ü', 'v2.0 → v3.0 migration', '--x--', '123', 'sk-ant-abcdefghijklmnopqrstuv'];
  for (const [i, g] of goals.entries()) {
    const k = makeTaskKey(i + 1, g);
    assert.equal(isValidTaskKey(k), true, `${JSON.stringify(g)} → ${k}`);
  }
  assert.equal(isValidTaskKey(makeTaskKey(9_999_999_999, 'x')), true);
  for (const bad of ['', null, undefined, 42, 'T1-x', 't1-', 't1--x', 't1-x-', 'tx-abc', 't1_abc', 't1-ABC', '../t1-x', 't1-x/y',
    't12345678901-x', `t1-${'a'.repeat(41)}`, 't1-a b', 't1-x\n']) {
    assert.equal(isValidTaskKey(bad), false, String(bad));
  }
  assert.equal(isValidTaskKey(`t1-${'a'.repeat(40)}`), true);
});

// ---- redaction ----

test('sanitizeTaskText: model keys, Bearer tokens, password/token/secret/api_key values, PEM blocks', () => {
  const cases = [
    ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 here', /sk-ant-api03/],
    ['curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part-x"', /eyJhbGci/],
    ['login with password=hunter2&user=bob', /hunter2/],
    ['set token=abc123def', /abc123def/],
    ['secret = "s3cr3t value"', /s3cr3t/],
    ["api_key='zzz-999'", /zzz-999/],
    ['api-key=QWERTY12', /QWERTY12/],
    ['DB_PASSWORD=pa55 GITHUB_TOKEN=ghx_1234', /pa55|ghx_1234/],
    ['{"password": "p@ss", "client_secret":"cs-1"}', /p@ss|cs-1/],
    ['ghp_abcdefghijklmnopqrstuvwxyz and AKIAABCDEFGHIJKLMNOP', /ghp_abc|AKIAABCD/],
  ];
  for (const [input, leak] of cases) {
    const out = sanitizeTaskText(input);
    assert.doesNotMatch(out, leak, input);
    assert.match(out, /\[REDACTED/, input);
  }
  // The key name stays so the sentence still reads.
  assert.equal(sanitizeTaskText('use password=hunter2 now'), 'use password=[REDACTED] now');
  assert.equal(sanitizeTaskText('Authorization: Bearer abcdef123456'), 'Authorization: Bearer [REDACTED]');
  const pem = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----\nafter';
  assert.equal(sanitizeTaskText(pem), 'before\n[REDACTED PRIVATE KEY]\nafter');
  // A clipped PEM (no END line) is redacted to the end, never leaked.
  assert.equal(sanitizeTaskText('x -----BEGIN PRIVATE KEY-----\nMIIabc'), 'x [REDACTED PRIVATE KEY]');
  // Prose survives: no over-eager masking.
  assert.equal(sanitizeTaskText('Add Bearer authentication to the API'), 'Add Bearer authentication to the API');
  assert.equal(sanitizeTaskText('if (token === null) return'), 'if (token === null) return');
  assert.equal(sanitizeTaskText('Rotate the secret on the settings page'), 'Rotate the secret on the settings page');
});

test('sanitizeTaskText: trims and clips with "…" (never longer than max), redacting before the cut', () => {
  assert.equal(sanitizeTaskText('   hello  '), 'hello');
  assert.equal(sanitizeTaskText(null), '');
  const out = sanitizeTaskText('x'.repeat(5000));
  assert.equal(out.length, 2000);
  assert.ok(out.endsWith('…'));
  assert.equal(sanitizeTaskText('abcdefghij', { max: 5 }), 'abcd…');
  assert.equal(sanitizeTaskText('abc', { max: 0 }), '');
  // A secret straddling the cut is still masked whole.
  const straddle = sanitizeTaskText(`${'a'.repeat(10)} sk-ant-abcdefghijklmnopqrstuvwxyz`, { max: 20 });
  assert.doesNotMatch(straddle, /sk-ant/);
});

// ---- hydrate ----

test('hydrateTask: DB row → camelCase task with JSON columns parsed; bad JSON reads empty', () => {
  const row = {
    id: 5, task_key: 't5-x', project_id: 3, intent: 'build', status: 'active', goal: 'X', request_id: 9,
    last_cycle_id: null, authorized_by: 2, authorized_at: 'A', folder: '/srv/app', branch: null,
    last_verified_step: null, next_step: 'N', completed_steps_json: '[{"step":"s","at":"t"},{"nope":1}]',
    checks_json: '[{"key":"lint","status":"passed"}]', blockers_json: '["b"]', remaining_json: '["r"]',
    uncertain_json: '["u"]', context_json: '{"answerExcerpt":"e"}', revision: 3, files_revision: 1,
    created_at: 'C', updated_at: 'U', finished_at: null,
  };
  const t = hydrateTask(row);
  assert.deepEqual(t, {
    id: 5, key: 't5-x', projectId: 3, intent: 'build', status: 'active', goal: 'X', requestId: 9, lastCycleId: null,
    authorizedBy: 2, authorizedAt: 'A', folder: '/srv/app', branch: null, lastVerifiedStep: null, nextStep: 'N',
    completedSteps: [{ step: 's', at: 't' }], checks: [{ key: 'lint', status: 'passed' }], blockers: ['b'],
    remaining: ['r'], uncertain: ['u'], context: { answerExcerpt: 'e' }, revision: 3, filesRevision: 1,
    createdAt: 'C', updatedAt: 'U', finishedAt: null,
  });
  const broken = hydrateTask({ ...row, completed_steps_json: '{oops', checks_json: 'null', blockers_json: '"str"', remaining_json: null, uncertain_json: '', context_json: '[1,2]' });
  assert.deepEqual(broken.completedSteps, []);
  assert.deepEqual(broken.checks, []);
  assert.deepEqual(broken.blockers, []);
  assert.deepEqual(broken.remaining, []);
  assert.deepEqual(broken.uncertain, []);
  assert.equal(broken.context, null);
  assert.equal(hydrateTask(null), null);
  assert.equal(hydrateTask(undefined), null);
});

// ---- cycle → task status ----

test('buildTaskStatusFromCycle: the spec table, row by row', () => {
  const s = (cycle) => buildTaskStatusFromCycle(cycle);
  for (const status of ['queued', 'estimating', 'running']) {
    assert.deepEqual(s({ status }), { status: 'active', blockers: [], nextStep: null, canResume: false }, status);
  }
  assert.deepEqual(s({ status: 'awaiting_user', verification_state: 'pending' }),
    { status: 'completed', blockers: [], nextStep: 'Verify the change in the live app', canResume: false });
  assert.deepEqual(s({ status: 'awaiting_user', verification_state: 'verified' }),
    { status: 'completed', blockers: [], nextStep: null, canResume: false });
  assert.deepEqual(s({ status: 'awaiting_user', verification_state: null }),
    { status: 'blocked', blockers: ['Waiting for answers to open questions'], nextStep: null, canResume: false });
  assert.deepEqual(s({ status: 'awaiting_admin', halt_reason: 'Needs a schema decision', error: 'e' }).blockers, ['Needs a schema decision']);
  assert.deepEqual(s({ status: 'awaiting_admin', error: 'gate red' }), { status: 'blocked', blockers: ['gate red'], nextStep: null, canResume: true });
  assert.deepEqual(s({ status: 'awaiting_admin' }).blockers, ['Waiting for an administrator']);
  const quota = s({ status: 'refused_quota', error: 'monthly cap reached' });
  assert.equal(quota.status, 'blocked');
  assert.equal(quota.canResume, true);
  assert.match(quota.blockers[0], /^Over budget/);
  assert.match(quota.blockers[0], /monthly cap reached/);
  assert.deepEqual(s({ status: 'refused_quota' }).blockers, ['Over budget']);
  assert.deepEqual(s({ status: 'interrupted' }), { status: 'interrupted', blockers: [], nextStep: 'Resume from the last checkpoint', canResume: true });
  assert.deepEqual(s({ status: 'failed', error: 'orphaned by restart' }), { status: 'interrupted', blockers: [], nextStep: 'Resume from the last checkpoint', canResume: true });
  assert.deepEqual(s({ status: 'failed', error: 'deploy failed: port in use' }), { status: 'failed', blockers: ['deploy failed: port in use'], nextStep: null, canResume: true });
  assert.deepEqual(s({ status: 'abandoned' }), { status: 'stopped', blockers: [], nextStep: null, canResume: true });
  assert.deepEqual(s({ status: 'succeeded' }), { status: 'completed', blockers: [], nextStep: null, canResume: false });
  assert.equal(s({ status: 'something_new' }), null);
  assert.equal(s(null), null);
  // Errors are redacted before they become a blocker.
  assert.doesNotMatch(s({ status: 'failed', error: 'auth failed with token=abc123' }).blockers[0], /abc123/);
});

// ---- classification ----

const CONTINUE = ['continue', 'keep going', 'carry on', 'go on', 'resume', 'proceed', 'try again', 'retry', 'again',
  'finish', 'finish it', 'finish this', 'finish up', 'finish the build', 'finish the task', 'finish the job', 'finish the work',
  'pick it up', 'pick it back up', 'pick up where you left off', 'continue where you left off', 'do it again', 'run it again', 'same again'];
const STOP = ['stop', 'stop it', 'stop that', 'stop the build', 'stop building', 'stop working', 'cancel', 'cancel it',
  'cancel the build', 'abort', 'halt', 'pause', 'pause the build', "don't continue", 'do not continue', 'never mind', 'nevermind'];
const EXPLAIN_LEADING = ['only explain', 'just explain', 'explain only', 'only tell me', 'just tell me', 'only answer', 'just answer'];
const EXPLAIN_ANYWHERE = ["don't change anything", 'do not change anything', "don't make any changes", 'do not make any changes',
  'without changing anything', 'without making any changes', "don't build anything", 'do not build anything', 'no code changes',
  "don't edit anything", 'do not edit anything'];

test('classify: every continue phrase, with polite words, case, punctuation and emoji', () => {
  for (const p of CONTINUE) {
    for (const v of [p, p.toUpperCase(), `please ${p}`, `${p} please`, `ok ${p}`, `Okay, ${p}.`, `${p}!`, `${p}...`, `  ${p} 👍 `, `${p} 🙏🏽`, `Please, ${p}, please!`]) {
      assert.deepEqual(classifyContinuationMessage(v), { kind: 'continue', guidance: '' }, v);
    }
  }
});

test('classify: every stop phrase (curly apostrophes too)', () => {
  for (const p of STOP) {
    for (const v of [p, p.toUpperCase(), `please ${p}`, `${p}!`, `ok ${p}.`, p.replace("'", '’')]) {
      assert.deepEqual(classifyContinuationMessage(v), { kind: 'stop', guidance: '' }, v);
    }
  }
});

test('classify: explain-only — a LEADING directive (after please/ok), case-insensitive; guidance is the full text', () => {
  for (const p of EXPLAIN_LEADING) {
    for (const msg of [`${p} how the invoice total is computed`, `${p.toUpperCase()}: why does the export time out?`, `Please ${p} what the cron job does`, `ok, ${p} where the session is stored`]) {
      assert.deepEqual(classifyContinuationMessage(msg), { kind: 'explain_only', guidance: msg }, msg);
    }
    // Not leading → not a directive.
    assert.equal(classifyContinuationMessage(`Add a help page that will ${p} the pricing`).kind, 'other', p);
  }
  assert.equal(classifyContinuationMessage('just explain why the login fails').kind, 'explain_only');
  assert.equal(classifyContinuationMessage('explain only: how does auth work').kind, 'explain_only');
});

test('classify: explain-only — a whole-intent phrase anywhere (straight, curly or no apostrophe)', () => {
  for (const p of EXPLAIN_ANYWHERE) {
    for (const v of [p, p.toUpperCase(), p.replace("'", '\u2019'), p.replace("'", '')]) {
      const msg = `How does the invoice total get computed? ${v}, I want to understand it first.`;
      assert.deepEqual(classifyContinuationMessage(msg), { kind: 'explain_only', guidance: msg }, msg);
    }
  }
  assert.equal(classifyContinuationMessage('Why does the login fail? Don\'t change anything.').kind, 'explain_only');
  assert.equal(classifyContinuationMessage('Don\u2019t change anything, but what would the fix be?').kind, 'explain_only');
  // The newer instruction wins over a continuation.
  assert.equal(classifyContinuationMessage("continue, but don't change anything").kind, 'explain_only');
});

test('classify: explain-only negatives — a build request that merely mentions the words still builds', () => {
  for (const msg of [
    'Make the email field read-only', 'Show the status read only for viewers', 'no changes to the footer please, just fix the header',
    "don't touch the footer, fix the nav", "don't build the export yet — first add the filter", 'Add the export without changing the layout',
    "Don't make changes to the API, only the UI", 'Do not touch the auth module', 'Build a read-only replica view',
    'Add a "just tell me" tooltip to the form',
  ]) {
    assert.deepEqual(classifyContinuationMessage(msg), { kind: 'other', guidance: '' }, msg);
  }
});

test('FD0130-1 guided explanation overrides continuation before a build receives tools', () => {
  for (const msg of [
    'continue, but only explain the problem',
    'try again, just explain why',
    'resume: please only tell me what failed',
    'Please continue and just answer the question.',
    'retry — but please explain only why the login fails',
    'keep going with only explain the plan',
    'continue, but only explain ' + 'x'.repeat(MAX_GUIDANCE_CHARS + 1),
  ]) {
    assert.deepEqual(classifyContinuationMessage(msg), { kind: 'explain_only', guidance: msg }, msg);
    const decision = resolveTaskRoute({ message: msg, lane: 'build', tasks: [task({ status: 'interrupted' })], nowMs: NOW });
    assert.equal(decision.action, 'investigate', msg);
    assert.equal(decision.taskKey, null, msg);
    assert.equal(decision.guidance, msg, msg);
    assert.equal(resolveTaskRoute({ message: msg, lane: 'ask', tasks: [], nowMs: NOW }).action, 'pass', msg);
  }
  for (const msg of [
    'continue, but make the email field read-only',
    'continue, add a tooltip that says just explain',
    'resume: add a help page that will only explain the pricing',
  ]) {
    assert.equal(classifyContinuationMessage(msg).kind, 'continue', msg);
    assert.equal(resolveTaskRoute({ message: msg, lane: 'build', tasks: [task({ status: 'interrupted' })], nowMs: NOW }).action, 'resume_build', msg);
  }
});

test('classify: continuation with guidance — separators and and/but/with; remainder kept verbatim', () => {
  const cases = [
    ['continue, but skip the e2e tests', 'but skip the e2e tests'],
    ['Continue: use the v2 endpoint', 'use the v2 endpoint'],
    ['resume; the DB is back up', 'the DB is back up'],
    ['try again — the network is fixed', 'the network is fixed'],
    ['retry - Use Postgres 16', 'Use Postgres 16'],
    ['keep going – almost there', 'almost there'],
    ['finish it, then deploy', 'then deploy'],
    ['finish this: add the CSV header row', 'add the CSV header row'],
    ['finish, quickly', 'quickly'],
    ['continue and add a test for the export', 'add a test for the export'],
    ['resume but leave the styling alone', 'leave the styling alone'],
    ['try again with the staging key', 'the staging key'],
    ['retry with smaller batches', 'smaller batches'],
    ['keep going and fix the lint errors', 'fix the lint errors'],
    ['please continue, the API is reachable now.', 'the API is reachable now'],
  ];
  for (const [msg, guidance] of cases) {
    assert.deepEqual(classifyContinuationMessage(msg), { kind: 'continue', guidance }, msg);
  }
  // Guidance up to the cap is a continuation; past it the message is an instruction.
  assert.equal(classifyContinuationMessage(`continue: ${'x'.repeat(MAX_GUIDANCE_CHARS)}`).kind, 'continue');
  assert.equal(classifyContinuationMessage(`continue: ${'x'.repeat(MAX_GUIDANCE_CHARS + 1)}`).kind, 'other');
});

test('classify: negatives — sentences that merely contain the words are instructions, "go ahead" is not a continuation', () => {
  const others = [
    'stop the timer from resetting', 'Stop the page from scrolling to the top', 'cancel button should be red',
    'Add a pause button to the player', 'go ahead', 'Go ahead and build it', 'go ahead with the plan', 'ok go ahead',
    'continue the onboarding redesign', 'Continue to the next screen after login', 'can you continue?',
    'finish the login page', 'retry failed webhooks automatically', 'try again later message on the error page',
    'resume uploads after a network drop', 'please', 'ok', 'okay!', '', '   ', '👍', 'again and again until it works',
    'keep going back to the dashboard is annoying', 'proceed to checkout should skip the cart',
    `${'Build the reporting module. '.repeat(40)} continue`,
    `continue ${'with the long list of things to do and more things '.repeat(20)}`,
  ];
  for (const msg of others) {
    assert.deepEqual(classifyContinuationMessage(msg), { kind: 'other', guidance: '' }, msg.slice(0, 60));
  }
  assert.deepEqual(classifyContinuationMessage(null), { kind: 'other', guidance: '' });
});

// ---- picking ----

test('pickContinuationTask: newest unfinished; stale dropped; stopped only when newest; ties → higher id', () => {
  const a = task({ id: 1, key: 't1-a', status: 'interrupted', updatedAt: ago(30 * MIN) });
  const b = task({ id: 2, key: 't2-b', status: 'failed', updatedAt: ago(10 * MIN) });
  const done = task({ id: 3, key: 't3-c', status: 'completed', updatedAt: ago(1 * MIN) });
  assert.equal(pickContinuationTask([a, b, done], { nowMs: NOW }).key, 't2-b', 'completed never continues');
  const stoppedNewest = task({ id: 4, key: 't4-d', status: 'stopped', updatedAt: ago(0) });
  assert.equal(pickContinuationTask([a, b, stoppedNewest], { nowMs: NOW }).key, 't4-d');
  const stoppedOld = task({ id: 5, key: 't5-e', status: 'stopped', updatedAt: ago(60 * MIN) });
  assert.equal(pickContinuationTask([a, stoppedOld, done], { nowMs: NOW }).key, 't1-a', 'a stopped task that is not the newest is skipped');
  assert.equal(pickContinuationTask([stoppedOld, done], { nowMs: NOW }), null);
  const stale = task({ id: 6, key: 't6-f', status: 'interrupted', updatedAt: ago((CONTINUATION_STALE_DAYS + 1) * DAY) });
  assert.equal(pickContinuationTask([stale], { nowMs: NOW }), null, 'older than the stale window');
  const edge = task({ id: 7, key: 't7-g', status: 'interrupted', updatedAt: ago(CONTINUATION_STALE_DAYS * DAY - MIN) });
  assert.equal(pickContinuationTask([edge], { nowMs: NOW }).key, 't7-g');
  const bad = task({ id: 8, key: 't8-h', status: 'interrupted', updatedAt: 'not a date' });
  assert.equal(pickContinuationTask([bad], { nowMs: NOW }), null);
  const tie1 = task({ id: 10, key: 't10-x', status: 'blocked', updatedAt: ago(5 * MIN) });
  const tie2 = task({ id: 11, key: 't11-y', status: 'blocked', updatedAt: ago(5 * MIN) });
  assert.equal(pickContinuationTask([tie1, tie2], { nowMs: NOW }).key, 't11-y');
  assert.equal(pickContinuationTask([], { nowMs: NOW }), null);
  assert.equal(pickContinuationTask(null, { nowMs: NOW }), null);
});

test('pickCurrentTask: a live task first, else the newest unfinished, else null', () => {
  const live = task({ id: 1, key: 't1-a', status: 'active', live: true, updatedAt: ago(60 * MIN) });
  const newer = task({ id: 2, key: 't2-b', status: 'interrupted', updatedAt: ago(1 * MIN) });
  const done = task({ id: 3, key: 't3-c', status: 'completed', updatedAt: ago(0) });
  assert.equal(pickCurrentTask([newer, live, done]).key, 't1-a');
  assert.equal(pickCurrentTask([newer, done]).key, 't2-b');
  assert.equal(pickCurrentTask([done]), null);
  assert.equal(pickCurrentTask([]), null);
});

// ---- routing ----

const route = (message, lane, tasks) => resolveTaskRoute({ message, lane, tasks, nowMs: NOW });

test('resolveTaskRoute: pass — an ordinary message, or nothing to resolve against', () => {
  const t = [task({ updatedAt: ago(MIN), canResume: true })];
  for (const lane of ['build', 'ask']) {
    assert.deepEqual(route('Add a CSV export to the invoices page', lane, t), { action: 'pass', taskKey: null, guidance: '', reason: 'not_a_continuation' });
    assert.equal(route('go ahead', lane, t).action, 'pass');
    assert.equal(route('continue', lane, []).action, 'pass');
    assert.equal(route('continue', lane, [task({ status: 'completed', updatedAt: ago(MIN) })]).action, 'pass');
    assert.equal(route('continue', lane, [task({ updatedAt: ago(30 * DAY) })]).action, 'pass', 'stale');
  }
});

test('resolveTaskRoute: resume_build — a resumable, not-live build, in either lane, with guidance', () => {
  const t = [task({ updatedAt: ago(MIN), canResume: true })];
  for (const lane of ['build', 'ask']) {
    assert.deepEqual(route('continue', lane, t), { action: 'resume_build', taskKey: 't12-add-invoice-export', guidance: '', reason: 'resume_build' });
    assert.deepEqual(route('try again, the DB is up', lane, t), { action: 'resume_build', taskKey: 't12-add-invoice-export', guidance: 'the DB is up', reason: 'resume_build' });
  }
  // No canResume annotation: the statuses the cycle table marks resumable are.
  assert.equal(route('retry', 'build', [task({ status: 'failed', updatedAt: ago(MIN) })]).action, 'resume_build');
  assert.equal(route('continue', 'build', [task({ status: 'stopped', updatedAt: ago(MIN) })]).action, 'resume_build', 'the newest task, stopped');
  // A build that cannot be resumed (and is not waiting on answers) passes through.
  assert.deepEqual(route('continue', 'build', [task({ status: 'active', canResume: false, updatedAt: ago(MIN) })]),
    { action: 'pass', taskKey: null, guidance: '', reason: 'build_not_resumable' });
});

test('resolveTaskRoute: attach — the picked task is live (build or investigation)', () => {
  const liveBuild = task({ status: 'active', live: true, updatedAt: ago(MIN) });
  const liveAsk = task({ id: 20, key: 't20-why', intent: 'investigation', status: 'active', live: true, updatedAt: ago(MIN) });
  for (const lane of ['build', 'ask']) {
    assert.deepEqual(route('continue', lane, [liveBuild]), { action: 'attach', taskKey: 't12-add-invoice-export', guidance: '', reason: 'task_already_running' });
    assert.equal(route('keep going', lane, [liveAsk]).action, 'attach');
  }
});

test('resolveTaskRoute: answer_required — a blocked build that cannot resume until answered', () => {
  const blocked = task({ status: 'blocked', canResume: false, blockers: ['Waiting for answers to open questions'], updatedAt: ago(MIN) });
  for (const lane of ['build', 'ask']) {
    assert.deepEqual(route('continue', lane, [blocked]), { action: 'answer_required', taskKey: 't12-add-invoice-export', guidance: '', reason: 'build_waiting_for_answers' });
  }
  // Blocked on an admin / budget: resumable.
  assert.equal(route('continue', 'build', [task({ status: 'blocked', canResume: true, updatedAt: ago(MIN) })]).action, 'resume_build');
});

test('resolveTaskRoute: continue_investigation — read-only in BOTH lanes (an investigation never authorizes a build)', () => {
  const inv = task({ id: 21, key: 't21-why-is-login-slow', intent: 'investigation', status: 'interrupted', canResume: true, updatedAt: ago(MIN) });
  for (const lane of ['build', 'ask']) {
    assert.deepEqual(route('continue', lane, [inv]), { action: 'continue_investigation', taskKey: 't21-why-is-login-slow', guidance: '', reason: 'continue_investigation' });
    assert.equal(route('resume: look at the DB indexes', lane, [inv]).guidance, 'look at the DB indexes');
  }
  // A newer investigation wins over an older interrupted build — and stays read-only.
  const build = task({ updatedAt: ago(60 * MIN), canResume: true });
  assert.equal(route('continue', 'build', [build, inv]).action, 'continue_investigation');
});

test('resolveTaskRoute: investigate — "only explain" in the build lane goes to the ask lane; in the ask lane it passes', () => {
  const t = [task({ updatedAt: ago(MIN), canResume: true })];
  const msg = 'Just explain how the export would work';
  assert.deepEqual(route(msg, 'build', t), { action: 'investigate', taskKey: null, guidance: msg, reason: 'explain_only_in_build_lane' });
  assert.deepEqual(route(msg, 'build', []), { action: 'investigate', taskKey: null, guidance: msg, reason: 'explain_only_in_build_lane' });
  assert.deepEqual(route(msg, 'ask', t), { action: 'pass', taskKey: null, guidance: '', reason: 'explain_only_in_ask_lane' });
});

test('resolveTaskRoute: stop_build — the live build, preferred over a newer unfinished task', () => {
  const live = task({ id: 30, key: 't30-live', status: 'active', live: true, updatedAt: ago(60 * MIN) });
  const newer = task({ id: 31, key: 't31-newer', status: 'interrupted', updatedAt: ago(MIN) });
  for (const lane of ['build', 'ask']) {
    assert.deepEqual(route('stop', lane, [newer, live]), { action: 'stop_build', taskKey: 't30-live', guidance: '', reason: 'stop_live_build' });
  }
});

test('resolveTaskRoute: stop_task — nothing live, an unfinished task is marked stopped', () => {
  const t = [task({ status: 'interrupted', updatedAt: ago(MIN) }), task({ id: 2, key: 't2-done', status: 'completed', updatedAt: ago(0) })];
  for (const lane of ['build', 'ask']) {
    assert.deepEqual(route('cancel', lane, t), { action: 'stop_task', taskKey: 't12-add-invoice-export', guidance: '', reason: 'stop_unfinished_task' });
  }
});

test('resolveTaskRoute: nothing_to_stop — nothing running or unfinished; a live answer cannot be stopped', () => {
  for (const lane of ['build', 'ask']) {
    assert.deepEqual(route('stop', lane, []), { action: 'nothing_to_stop', taskKey: null, guidance: '', reason: 'nothing_running_or_unfinished' });
    assert.equal(route('never mind', lane, [task({ status: 'completed', updatedAt: ago(MIN) })]).action, 'nothing_to_stop');
    assert.equal(route('stop', lane, [task({ status: 'stopped', updatedAt: ago(MIN) })]).action, 'nothing_to_stop', 'already stopped');
    assert.equal(route('stop', lane, [task({ status: 'interrupted', updatedAt: ago(30 * DAY) })]).action, 'nothing_to_stop', 'stale');
  }
  const liveAsk = task({ id: 20, key: 't20-why', intent: 'investigation', status: 'active', live: true, updatedAt: ago(MIN) });
  const older = task({ status: 'interrupted', updatedAt: ago(30 * MIN) });
  assert.deepEqual(route('stop', 'ask', [liveAsk, older]), { action: 'nothing_to_stop', taskKey: 't20-why', guidance: '', reason: 'investigation_cannot_stop' });
});

// ---- crash evidence ----

test('uncertainFromEvents: an unanswered tool call in the last turn is uncertain; answered ones are not', () => {
  const events = [
    { seq: 1, kind: 'task', content: 'Add export' },
    { seq: 2, kind: 'ai_message', content: 'Running the migration' },
    { seq: 3, kind: 'tool_call', content: 'read_file', meta: { name: 'read_file', input: { path: 'src/db.ts' } } },
    { seq: 4, kind: 'tool_call', content: 'run_command', meta: { name: 'run_command', input: { command: 'npm run migrate' } } },
    { seq: 5, kind: 'tool_result', content: 'ok', meta: { name: 'read_file' } },
  ];
  assert.deepEqual(uncertainFromEvents(events), ['Check whether run_command (npm run migrate) completed before repeating it']);
  assert.deepEqual(uncertainFromEvents([...events, { seq: 6, kind: 'tool_result', content: 'done', meta: { name: 'run_command' } }]), []);
  // Out-of-order input is sorted by seq.
  assert.deepEqual(uncertainFromEvents([...events].reverse()), ['Check whether run_command (npm run migrate) completed before repeating it']);
});

test('uncertainFromEvents: a call unanswered in an EARLIER turn was handled (the runner moved on); interleaved calls pair', () => {
  const events = [
    { seq: 1, kind: 'ai_message' },
    { seq: 2, kind: 'tool_call', meta: { name: 'finish', input: { summary: 'done' } } },
    { seq: 3, kind: 'note', content: 'Halt rejected' },
    { seq: 4, kind: 'ai_message' },
    { seq: 5, kind: 'tool_call', meta: { name: 'write_file', input: { path: 'a.ts', content: 'x' } } },
    { seq: 6, kind: 'tool_result', meta: { name: 'write_file' } },
    { seq: 7, kind: 'tool_call', meta: { name: 'run_command', input: { command: 'npm test' } } },
  ];
  assert.deepEqual(uncertainFromEvents(events), ['Check whether run_command (npm test) completed before repeating it']);
  const gated = [...events, { seq: 8, kind: 'tool_result', meta: { name: 'run_command' } }, { seq: 9, kind: 'tool_call', meta: { name: 'finish' } }, { seq: 10, kind: 'gate', content: 'ok' }];
  assert.deepEqual(uncertainFromEvents(gated), [], 'gates ran, so the finish call was handled');
});

test('uncertainFromEvents: a deploy without an outcome, or cycle.deploy_status deploying; summaries redacted; max 8', () => {
  const deployLine = 'A deploy was in progress when the build stopped — check whether the app serves the new version before deploying again';
  assert.deepEqual(uncertainFromEvents([{ seq: 1, kind: 'deploy', content: 'deploying', meta: { started: true } }]), [deployLine]);
  assert.deepEqual(uncertainFromEvents([{ seq: 1, kind: 'deploy', meta: { started: true } }, { seq: 2, kind: 'deploy', meta: { ok: true } }]), []);
  assert.deepEqual(uncertainFromEvents([{ seq: 1, kind: 'deploy', meta: { ok: false } }]), [], 'a failed deploy reported its outcome');
  assert.deepEqual(uncertainFromEvents([], { cycle: { deploy_status: 'deploying' } }), [deployLine]);
  assert.deepEqual(uncertainFromEvents([], { cycle: { deploy_status: 'serving' } }), []);
  const secret = uncertainFromEvents([{ seq: 1, kind: 'tool_call', meta: { name: 'run_command', input: { command: 'curl -H "Authorization: Bearer abcdef123456" https://api' } } }]);
  assert.equal(secret.length, 1);
  assert.doesNotMatch(secret[0], /abcdef123456/);
  const many = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, kind: 'tool_call', meta: { name: `tool_${i}`, input: { path: `f${i}` } } }));
  const out = uncertainFromEvents(many, { cycle: { deploy_status: 'deploying' } });
  assert.equal(out.length, MAX_UNCERTAIN);
  assert.equal(out[0], deployLine, 'the deploy comes first');
  for (const line of out.slice(1)) assert.match(line, /^Check whether tool_\d+ \(f\d+\) completed before repeating it$/);
  assert.deepEqual(uncertainFromEvents(null), []);
  // Input without a known field falls back to clipped JSON; no input → just the name.
  assert.match(uncertainFromEvents([{ seq: 1, kind: 'tool_call', meta: { name: 'db_query', input: { sql: 'UPDATE t SET x=1' } } }])[0], /^Check whether db_query \(\{"sql":"UPDATE t SET x=1"\}\) completed/);
  assert.deepEqual(uncertainFromEvents([{ seq: 1, kind: 'tool_call', content: 'deploy_app' }]), ['Check whether deploy_app completed before repeating it']);
});

// ---- handoff parsing ----

test('parseHandoffSections: DONE / NEXT STEPS / GOTCHAS in any case, with colons, markdown, bullets or numbers', () => {
  const text = [
    'Some preamble the model wrote.',
    'DONE:',
    '- Added the export route',
    '- Wrote the CSV serializer',
    '  that escapes quotes',
    '',
    'NEXT STEPS:',
    '1. Add the download button in src/pages/Invoices.tsx',
    '2) Run the e2e gate',
    '',
    'GOTCHAS:',
    '* Do not regenerate the migration — it is applied',
  ].join('\n');
  assert.deepEqual(parseHandoffSections(text), {
    done: ['Added the export route', 'Wrote the CSV serializer that escapes quotes'],
    next: ['Add the download button in src/pages/Invoices.tsx', 'Run the e2e gate'],
    gotchas: ['Do not regenerate the migration — it is applied'],
  });
  const md = '## Done\n- a\n\n**Next steps:** b\n- c\n### gotchas\n• d\n  wrapped onto a second line\n\nDone with the API work (an item, not a heading)';
  assert.deepEqual(parseHandoffSections(md), { done: ['a'], next: ['b', 'c'], gotchas: ['d wrapped onto a second line', 'Done with the API work (an item, not a heading)'] });
  assert.deepEqual(parseHandoffSections('Next step: wire the UI'), { done: [], next: ['wire the UI'], gotchas: [] });
  assert.deepEqual(parseHandoffSections(''), { done: [], next: [], gotchas: [] });
  assert.deepEqual(parseHandoffSections(null), { done: [], next: [], gotchas: [] });
  assert.doesNotMatch(parseHandoffSections('DONE:\n- set password=hunter2').done[0], /hunter2/);
});

test('appendStep: newest last, the max newest kept, empty steps ignored, redacted', () => {
  let steps = [];
  for (let i = 0; i < 35; i += 1) steps = appendStep(steps, `step ${i}`, `2026-10-21T10:00:${String(i).padStart(2, '0')}.000Z`);
  assert.equal(steps.length, 30);
  assert.equal(steps[0].step, 'step 5');
  assert.equal(steps.at(-1).step, 'step 34');
  assert.deepEqual(appendStep(steps, '   ', 'x'), steps);
  assert.deepEqual(appendStep([{ step: 'a', at: 'x' }], 'b', 'y', { max: 1 }), [{ step: 'b', at: 'y' }]);
  const at = appendStep(null, 'with token=abc123')[0];
  assert.doesNotMatch(at.step, /abc123/);
  assert.match(at.at, /^\d{4}-\d\d-\d\dT/);
  const orig = [{ step: 'a', at: 'x' }];
  appendStep(orig, 'b', 'y');
  assert.equal(orig.length, 1, 'never mutates its input');
});

// ---- portable files ----

test('renderTaskJson: exactly the spec example — keys, order, values, two-space JSON + newline', () => {
  const expected = {
    schema: 'mock2-task@1', taskId: 't12-add-invoice-export', intent: 'build', status: 'interrupted', goal: 'Add invoice export',
    folder: '/srv/app', branch: 'main', requestId: 34, lastCycleId: 88, lastVerifiedStep: 'Checkpoint 1a2b3c4 committed',
    nextStep: 'Resume from the last checkpoint', completedSteps: [{ step: 'Build started', at: '2026-10-21T10:00:00.000Z' }],
    checks: [{ key: 'typecheck', status: 'passed' }], blockers: [], remaining: ['Run checks', 'Review changes'],
    uncertain: ['A deploy was in progress when the build stopped — check whether the app serves the new version before deploying again'],
    authorization: { source: 'person', action: 'build-request', at: '2026-10-21T10:00:00.000Z' },
    authority: 'ProxyPilot database. This file is a portable mirror; it authorizes nothing.', revision: 7, updatedAt: '2026-10-21T10:05:00.000Z',
  };
  const out = renderTaskJson(task());
  assert.equal(out, `${JSON.stringify(expected, null, 2)}\n`);
  assert.deepEqual(Object.keys(JSON.parse(out)), Object.keys(expected));
  assert.equal(JSON.parse(out).authority, TASK_AUTHORITY_NOTE);
});

test('renderTaskJson: no user identifiers or context ever; investigation → "question"; nulls stay null; text redacted', () => {
  const t = task({
    intent: 'investigation', authorizedBy: 4242, branch: null, requestId: null, lastCycleId: null, lastVerifiedStep: null, nextStep: null,
    context: { userEmail: 'thomas@example.com', username: 'thomas', answerExcerpt: 'secret findings' },
    goal: 'Why does login fail with password=hunter2?',
  });
  const out = renderTaskJson(t);
  for (const leak of ['4242', 'thomas', '@example', 'answerExcerpt', 'secret findings', 'hunter2', 'authorizedBy', 'projectId', 'filesRevision']) {
    assert.ok(!out.includes(leak), leak);
  }
  const doc = JSON.parse(out);
  assert.equal(doc.authorization.action, 'question');
  assert.deepEqual(doc.authorization, { source: 'person', action: 'question', at: '2026-10-21T10:00:00.000Z' });
  for (const k of ['branch', 'requestId', 'lastCycleId', 'lastVerifiedStep', 'nextStep']) assert.equal(doc[k], null, k);
  // Lists are bounded.
  const big = JSON.parse(renderTaskJson(task({ uncertain: Array.from({ length: 20 }, (_, i) => `u${i}`), completedSteps: Array.from({ length: 50 }, (_, i) => ({ step: `s${i}`, at: 'x' })) })));
  assert.equal(big.uncertain.length, MAX_UNCERTAIN);
  assert.equal(big.completedSteps.length, 30);
  assert.equal(big.completedSteps.at(-1).step, 's49');
});

test('renderTaskHandoffMd: heading, goal, steps, the four sections ("none" when empty), the closing line; no identifiers', () => {
  const md = renderTaskHandoffMd(task({ authorizedBy: 4242, context: { userEmail: 'thomas@example.com' } }));
  assert.ok(md.startsWith('# Task t12-add-invoice-export — build — interrupted\n\n**Goal:** Add invoice export\n'));
  assert.match(md, /\*\*Last verified step:\*\* Checkpoint 1a2b3c4 committed\n\*\*Next step:\*\* Resume from the last checkpoint\n/);
  assert.match(md, /## Done\n- Build started \(2026-10-21T10:00:00\.000Z\)\n## Remaining\n- Run checks\n- Review changes\n## Verify before repeating\n- A deploy was in progress/);
  assert.match(md, /## Blockers\n- none\n/);
  assert.match(md, /Resume in Flightdeck with "continue" or the Resume button\. The ProxyPilot database is authoritative;\nthis file authorizes nothing\. Generated by ProxyPilot — edits are overwritten\.\n$/);
  for (const leak of ['4242', 'thomas', '@example']) assert.ok(!md.includes(leak), leak);
  const empty = renderTaskHandoffMd(task({ uncertain: [], remaining: [], completedSteps: [], lastVerifiedStep: null, nextStep: null }));
  assert.match(empty, /## Verify before repeating\n- none\n/);
  assert.match(empty, /\*\*Last verified step:\*\* —/);
  const many = renderTaskHandoffMd(task({ completedSteps: Array.from({ length: 25 }, (_, i) => ({ step: `s${i}`, at: null })) }));
  assert.match(many, /## Done\n- … 15 earlier step\(s\) in task\.json\n- s15\n(?:- s\d+\n){8}- s24\n## Remaining/);
  // Multi-line text never breaks a bullet.
  assert.match(renderTaskHandoffMd(task({ remaining: ['line one\nline two'] })), /- line one line two\n/);
});

// ---- resume context ----

test('buildRecoverySection: checkpoint path, state, verify-before-repeating list and the inspection rule', () => {
  const s = buildRecoverySection(task());
  assert.ok(s.startsWith('TASK CHECKPOINT (state/tasks/t12-add-invoice-export/task.json)\nGoal: Add invoice export\n'));
  for (const part of ['Last verified step: Checkpoint 1a2b3c4 committed', 'Next step: Resume from the last checkpoint', 'Remaining:\n- Run checks', 'Checks:\n- typecheck: passed',
    'VERIFY BEFORE REPEATING:\n- A deploy was in progress', 'git status, git diff against the last checkpoint, git log -3',
    'never repeat a deploy, migration, data change or external call whose outcome is uncertain until you have confirmed whether it already happened.']) {
    assert.ok(s.includes(part), part);
  }
  assert.match(buildRecoverySection(task({ uncertain: [] })), /VERIFY BEFORE REPEATING:\n- nothing was recorded as uncertain/);
  assert.match(buildRecoverySection(task({ key: null })), /^TASK CHECKPOINT \(state\/tasks\/<task>\/task\.json\)/, 'no key → no throw from the path helper');
});

test('buildRecoverySection: bounded — a huge task still fits, the verify list and the rule always survive', () => {
  const huge = task({
    goal: 'g'.repeat(5000), lastVerifiedStep: 'l'.repeat(5000), nextStep: 'n'.repeat(5000),
    remaining: Array.from({ length: 100 }, (_, i) => `remaining ${i} ${'r'.repeat(400)}`),
    checks: Array.from({ length: 100 }, (_, i) => ({ key: `check-${i}`, status: 'failed' })),
    blockers: Array.from({ length: 50 }, () => 'b'.repeat(400)),
    uncertain: Array.from({ length: 20 }, (_, i) => `Check whether op ${i} completed ${'u'.repeat(400)}`),
  });
  const s = buildRecoverySection(huge);
  assert.ok(s.length <= RECOVERY_SECTION_MAX, String(s.length));
  assert.match(s, /VERIFY BEFORE REPEATING:\n- Check whether op 0/);
  assert.match(s, /- Check whether op 7/);
  assert.ok(s.endsWith('until you have confirmed whether it already happened.'));
});

test('buildInvestigationContinuation: goal, what was found, guidance, and the read-only rule', () => {
  const t = task({ intent: 'investigation', goal: 'Why is login slow?', context: { answerExcerpt: 'The users query has no index on email.' } });
  const q = buildInvestigationContinuation({ task: t, guidance: 'check the sessions table too' });
  assert.match(q, /^Continue the earlier investigation: Why is login slow\?/);
  assert.match(q, /What was found so far:\nThe users query has no index on email\./);
  assert.match(q, /Now: check the sessions table too/);
  assert.ok(q.endsWith('This is a read-only investigation: answer and propose; do not change code.'));
  const bare = buildInvestigationContinuation({ task: task({ intent: 'investigation', context: null }) });
  assert.match(bare, /\(nothing was recorded before it stopped\)/);
  assert.doesNotMatch(bare, /Now:/);
  assert.ok(buildInvestigationContinuation({ task: task({ context: { answerExcerpt: 'x'.repeat(20000) } }), guidance: 'y'.repeat(5000) }).length < 4000);
});

test('routedNote: one plain sentence per action, goal clipped to ~80 chars', () => {
  const t = task();
  assert.equal(routedNote('resume_build', t), 'Resuming build: Add invoice export');
  assert.equal(routedNote('attach', t), 'Already running: Add invoice export — showing its progress');
  assert.equal(routedNote('continue_investigation', t), 'Continuing investigation: Add invoice export');
  assert.equal(routedNote('investigate', null), 'Answering without changing anything');
  assert.equal(routedNote('stop_build', t), 'Stopping the build after its current step: Add invoice export');
  assert.equal(routedNote('stop_task', t), 'Stopped: Add invoice export');
  assert.equal(routedNote('nothing_to_stop', null), 'Nothing is running to stop.');
  assert.match(routedNote('nothing_to_stop', task({ intent: 'investigation', live: true })), /already being written/);
  assert.equal(routedNote('answer_required', t), 'Add invoice export is waiting for your answers before it can continue.');
  assert.equal(routedNote('pass', t), '');
  const long = routedNote('resume_build', task({ goal: 'x'.repeat(300) }));
  assert.equal(long.length, 'Resuming build: '.length + 80);
  assert.ok(long.endsWith('…'));
  assert.equal(routedNote('stop_task', null), 'Stopped: the task');
});

test('publicTaskShape: the snake_case TaskShape, file paths, live/resumed/can_resume; never authorized_by or context', () => {
  const shape = publicTaskShape(task(), { live: false, resumed: false });
  assert.deepEqual(Object.keys(shape), ['key', 'id', 'intent', 'status', 'unfinished', 'goal', 'request_id', 'last_cycle_id', 'live', 'resumed',
    'can_resume', 'last_verified_step', 'next_step', 'remaining', 'blockers', 'uncertain', 'checks', 'completed_steps', 'files',
    'created_at', 'updated_at', 'finished_at']);
  assert.equal(shape.unfinished, true);
  assert.equal(shape.can_resume, true, 'interrupted → resumable by default');
  assert.deepEqual(shape.files, { task_json: 'state/tasks/t12-add-invoice-export/task.json', handoff_md: 'state/tasks/t12-add-invoice-export/handoff.md' });
  assert.equal(shape.request_id, 34);
  assert.equal(shape.last_cycle_id, 88);
  const live = publicTaskShape(task({ status: 'active' }), { live: true, resumed: true });
  assert.equal(live.live, true);
  assert.equal(live.resumed, true);
  assert.equal(live.can_resume, false);
  assert.equal(publicTaskShape(task({ status: 'blocked' }), { canResume: true }).can_resume, true, 'an explicit canResume wins');
  assert.equal(publicTaskShape(task({ status: 'completed' })).unfinished, false);
  assert.equal(publicTaskShape(task({ status: 'completed' })).can_resume, false);
  assert.equal(publicTaskShape(task({ key: null })).files, null, 'no key → no paths, no throw');
  assert.equal(publicTaskShape(null), null);
  const json = JSON.stringify(publicTaskShape(task({ authorizedBy: 4242, context: { userEmail: 'thomas@example.com' } })));
  assert.ok(!json.includes('4242') && !json.includes('thomas'));
  assert.equal(publicTaskShape(task({ completedSteps: Array.from({ length: 40 }, (_, i) => ({ step: `s${i}`, at: null })) })).completed_steps.length, 30);
});
