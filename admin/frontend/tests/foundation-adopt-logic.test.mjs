// Moving a pre-foundation project onto the application foundation — the pure
// rules (src/components/mock2/foundation-adopt-logic.js): the plan and
// progress readings, the confirm body, the words, and what the person may do.
//   node --test tests/foundation-adopt-logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../../backend/src/mock2/foundation-contract.js';
import {
  ADOPT_ACTION, GENERIC_NEXT_STEP, SAFETY_TEXT, ACTIVE_ADOPTION_STATES,
  formatDuration, downtimeText, ackText, blockerNextStep, blockerView, stepTitle, featureChoices, planView,
  featureNote, adoptBody, answeredAdoption, isAdoptionActive, adoptionEnded, adoptionView, canStartAdoption,
  showAdoptionWhenReady, rollbackCopy,
} from '../src/components/mock2/foundation-adopt-logic.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const plan = (over = {}) => ({
  ok: true,
  plan: {
    steps: [
      { name: 'snapshot', summary: 'Take a snapshot so the move can be rolled back.' },
      { name: 'copy_database', summary: 'Copy the database into the foundation.' },
    ],
    downtime: 240,
    database: { size_bytes: 412 * MiB, tables: 37 },
    disk: { free_bytes: 18.4 * GiB, needed_bytes: 1.9 * GiB },
    secrets_to_move: ['SESSION_SECRET', 'STRIPE_API_KEY', 'SESSION_SECRET'],
    features: { storage: 'on', embeddings: 'on' },
    warnings: [{ code: 'NATIVE_POSTGRES_KEPT', message: 'The native PostgreSQL is stopped, not removed.' }],
  },
  blockers: [],
  plan_token: 'tok_1',
  ...over,
});
const T = Date.parse('2026-10-25T10:00:00.000Z');
const iso = (s) => new Date(T + s * 1000).toISOString();
const steps = (states) => states.map(([name, state, extra = {}]) => ({ name, state, detail: null, started_at: null, finished_at: null, ...extra }));

test('words: the action, the safety line, and the plain reading of durations', () => {
  assert.equal(ADOPT_ACTION, 'Move onto the application foundation');
  assert.match(SAFETY_TEXT, /snapshot[\s\S]*rolled back[\s\S]*Nothing is deleted\./);
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(125_000), '2 min 5 s');
  assert.equal(formatDuration(120_000), '2 min');
  assert.equal(formatDuration(3_780_000), '1 h 3 min');
  assert.equal(formatDuration(-1), null);
  assert.equal(formatDuration('x'), null);
});

test('downtime: seconds, a sentence or an object; never false precision', () => {
  assert.equal(downtimeText(240), 'about 4 minutes');
  assert.equal(downtimeText(30), 'under a minute');
  assert.equal(downtimeText(60), 'about 1 minute');
  assert.equal(downtimeText(5400), 'about 1.5 hours');
  assert.equal(downtimeText('2–4 minutes'), '2–4 minutes');
  assert.equal(downtimeText({ estimate_seconds: 300 }), 'about 5 minutes');
  assert.equal(downtimeText({ min_seconds: 120, max_seconds: 300 }), 'about 2–5 minutes');
  assert.equal(downtimeText({ text: 'About 3 minutes' }), 'About 3 minutes');
  assert.equal(downtimeText(null), null);
  assert.equal(downtimeText({}), null);
  assert.equal(ackText('about 4 minutes'), 'I understand the app is offline for about 4 minutes during the move.');
  assert.equal(ackText('About 3 minutes'), 'I understand the app is offline for about 3 minutes during the move.');
  assert.equal(ackText(null), 'I understand the app is offline during the move.');
});

test('blockers: plain reasons, each with a next step (the server\'s own first)', () => {
  assert.deepEqual(blockerView({ code: 'BUILD_RUNNING', message: 'A build is running.' }), { code: 'BUILD_RUNNING', message: 'A build is running.', next: 'Wait for it to finish, then check again.' });
  assert.match(blockerNextStep({ code: 'INSUFFICIENT_DISK' }), /^Free up space/);
  assert.match(blockerNextStep({ code: 'FOUNDATION_UNAVAILABLE' }), /^Wake the project/);
  assert.match(blockerNextStep({ code: 'PROJECT_OFFLINE' }), /^Wake the project/);
  assert.match(blockerNextStep({ code: 'PROJECT_ARCHIVED' }), /^Unarchive/);
  assert.equal(blockerNextStep({ code: 'SOMETHING_NEW' }), GENERIC_NEXT_STEP);
  assert.equal(blockerNextStep({ code: 'X', next_step: 'Ask the owner.' }), 'Ask the owner.');
  assert.deepEqual(blockerView('Plain words'), { code: null, message: 'Plain words', next: GENERIC_NEXT_STEP });
  assert.equal(blockerView({ code: 'NO_MESSAGE' }).message, 'NO MESSAGE', 'a code with no message still reads as words');
});

test('plan: a confirmable plan reads every documented field', () => {
  const v = planView(plan());
  assert.equal(v.blocked, false);
  assert.equal(v.canConfirm, true);
  assert.equal(v.token, 'tok_1');
  assert.deepEqual(v.steps.map((s) => s.summary), ['Take a snapshot so the move can be rolled back.', 'Copy the database into the foundation.']);
  assert.equal(v.downtime, 'about 4 minutes');
  assert.equal(v.databaseText, '412 MB · 37 tables');
  assert.equal(v.diskText, '18.4 GB free · 1.9 GB needed');
  assert.equal(v.diskShort, false);
  assert.deepEqual(v.secrets, ['SESSION_SECRET', 'STRIPE_API_KEY'], 'names only, once each');
  assert.deepEqual(v.features, { storage: 'on', embeddings: 'on' });
  assert.deepEqual(v.warnings, ['The native PostgreSQL is stopped, not removed.']);
});

test('plan: blockers make it unconfirmable; tolerant of missing and odd fields', () => {
  const b = planView(plan({ blockers: [{ code: 'BUILD_RUNNING', message: 'A build is running.' }, { code: 'X' }, null], plan_token: null }));
  assert.equal(b.blocked, true);
  assert.equal(b.canConfirm, false);
  assert.deepEqual(b.blockers.map((x) => x.code), ['BUILD_RUNNING', 'X']);
  // A plan with blockers is never confirmable, even when a token came along.
  assert.equal(planView(plan({ blockers: ['Busy'] })).canConfirm, false);
  // No token and no blockers: nothing to confirm against.
  assert.equal(planView(plan({ plan_token: '' })).canConfirm, false);
  const empty = planView({});
  assert.deepEqual([empty.blocked, empty.steps, empty.secrets, empty.warnings, empty.downtime, empty.databaseText, empty.diskText],
    [false, [], [], [], null, null, null]);
  assert.deepEqual(empty.features, { storage: 'on', embeddings: 'on' }, 'both on by default');
  assert.equal(planView(null).canConfirm, false);
  const odd = planView({ plan: { steps: ['Do a thing', { name: 'start_app' }], database: { tables: ['a', 'b', 'c'] }, disk: { free_bytes: 1 * GiB, needed_bytes: 2 * GiB }, secrets_to_move: [{ name: 'API_KEY' }, '', 7], features: { storage: 'off' } }, plan_token: 't' });
  assert.deepEqual(odd.steps.map((s) => s.summary), ['Do a thing', 'Start the app']);
  assert.equal(odd.databaseText, '3 tables');
  assert.equal(odd.diskShort, true);
  assert.deepEqual(odd.secrets, ['API_KEY']);
  assert.deepEqual(odd.features, { storage: 'off', embeddings: 'on' });
  assert.equal(planView(plan({ plan: { database: { size_bytes: 0, tables: 1 } } })).databaseText, '0 B · 1 table');
});

test('features: on shows the local-embeddings note; off says what stays unavailable', () => {
  assert.deepEqual(featureChoices(undefined), { storage: 'on', embeddings: 'on' });
  assert.deepEqual(featureChoices({ storage: false, embeddings: 'off' }), { storage: 'off', embeddings: 'off' });
  assert.equal(featureNote('embeddings', 'on'), contract.LOCAL_EMBEDDINGS_WARNING);
  assert.match(featureNote('storage', 'on'), /external S3 later/);
  for (const name of ['storage', 'embeddings']) {
    const off = featureNote(name, 'off');
    for (const d of contract.DEPENDENT_CAPABILITIES[name]) assert(off.includes(d), `${name} off lists "${d}"`);
  }
});

test('confirm body: the token, the downtime acknowledgement and the feature choices', () => {
  const ok = adoptBody({ token: 'tok_1', acknowledge: true, features: { storage: 'on', embeddings: 'off' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body, { plan_token: 'tok_1', acknowledge_downtime: true, features: { storage: 'on', embeddings: 'off' } });
  const noAck = adoptBody({ token: 'tok_1', acknowledge: false });
  assert.equal(noAck.ok, false);
  assert.equal(noAck.errors.acknowledge, 'Tick the box to confirm the downtime.');
  assert.deepEqual(noAck.body.features, { storage: 'on', embeddings: 'on' });
  assert.equal(adoptBody({ acknowledge: true }).ok, false, 'no token, no confirm');
  assert.equal(adoptBody().ok, false);
});

test('progress: steps, the current step\'s detail, elapsed time, no buttons while running', () => {
  const now = T + 75_000;
  const a = {
    id: 'ad_1', state: 'running', step: 'copy_database',
    steps: steps([
      ['snapshot', 'done', { started_at: iso(0), finished_at: iso(12) }],
      ['copy_database', 'running', { started_at: iso(12), detail: { message: '120 of 412 MB copied' } }],
      ['start_app', 'pending'],
    ]),
    error: null, created_at: iso(0), finished_at: null, rollback_available: false,
  };
  const v = adoptionView(a, now);
  assert.equal(v.active, true);
  assert.equal(v.label, 'Moving');
  assert.equal(v.title, 'Moving onto the application foundation');
  assert.equal(v.progressText, '1 of 3 steps done');
  assert.equal(v.percent, 33);
  assert.equal(v.elapsedText, '1 min 15 s so far');
  assert.equal(v.current.name, 'copy_database');
  assert.equal(v.current.detail, '120 of 412 MB copied');
  assert.equal(v.currentDetail, '120 of 412 MB copied');
  assert.equal(v.showSteps, true);
  assert.deepEqual(v.steps.map((s) => [s.title, s.stateLabel, s.durationText]), [
    ['Take a snapshot', 'Done', '12 s'], ['Copy the database', 'Running', '1 min 3 s'], ['Start the app', 'Waiting', null],
  ]);
  assert.equal(v.canResume, false);
  assert.equal(v.canRollback, false);
  assert.equal(isAdoptionActive(a), true);
  assert.deepEqual(ACTIVE_ADOPTION_STATES, ['running', 'rolling_back']);
  assert.equal(adoptionView(null), null);
  assert.equal(adoptionView({ state: 'running' }).progressText, null, 'no steps reported yet');
});

test('failure: the error, Resume when offered, Roll back when available', () => {
  const failed = {
    state: 'failed', step: 'copy_database', error: 'Row counts differ in invoices (1204 vs 1203).',
    steps: steps([['snapshot', 'done'], ['copy_database', 'failed', { detail: 'Row counts differ.' }], ['start_app', 'pending']]),
    created_at: iso(0), finished_at: iso(90), rollback_available: true,
  };
  const v = adoptionView(failed, T + 500_000);
  assert.equal(v.active, false);
  assert.equal(v.label, 'Stopped');
  assert.equal(v.error, 'Row counts differ in invoices (1204 vs 1203).');
  assert.equal(v.elapsedText, 'Took 1 min 30 s');
  assert.equal(v.current.name, 'copy_database');
  assert.equal(v.showSteps, true, 'a stopped move shows where it stopped');
  assert.equal(v.progressText, '1 of 3 steps done');
  assert.equal(v.currentDetail, null, 'the error is not repeated under its step');
  assert.equal(adoptionView({ ...failed, steps: steps([['copy_database', 'failed', { detail: 'invoices: 1 row missing' }]]) }).currentDetail, 'invoices: 1 row missing');
  assert.equal(v.canResume, true, 'offered unless the server says otherwise');
  assert.equal(v.canRollback, true);
  assert.match(v.outcome, /^Nothing is deleted\. Resume to continue from the failed step, or roll back/);
  assert.equal(adoptionView({ ...failed, resume_available: false }).canResume, false);
  assert.equal(adoptionView({ ...failed, rollback_available: false }).canRollback, false);
  assert.equal(adoptionView({ ...failed, error: null }).error, 'The move stopped before it finished.');
  assert.equal(adoptionView({ ...failed, error: { message: 'disk full' } }).error, 'disk full');
});

test('success and roll back: Roll back only while available; the right words', () => {
  const ok = { state: 'succeeded', steps: steps([['snapshot', 'done'], ['start_app', 'done']]), created_at: iso(0), finished_at: iso(200), rollback_available: true };
  const v = adoptionView(ok);
  assert.equal(v.title, 'Moved onto the foundation');
  assert.equal(v.showSteps, false, 'a finished move is a short confirmation');
  assert.equal(v.progressText, null);
  assert.equal(v.elapsedText, 'Took 3 min 20 s');
  assert.equal(v.canRollback, true);
  assert.equal(v.canResume, false);
  assert.match(v.outcome, /You can still roll back/);
  assert.equal(adoptionView({ ...ok, rollback_available: false }).canRollback, false);
  assert.doesNotMatch(adoptionView({ ...ok, rollback_available: false }).outcome, /roll back/);
  assert.equal(adoptionView({ state: 'rolling_back', rollback_available: true }).canRollback, false, 'not while it runs');
  const back = adoptionView({ ...ok, state: 'rolling_back', rollback_available: false }, T + 400_000);
  assert.deepEqual([back.active, back.showSteps, back.percent, back.elapsedText], [true, false, null, null], 'a roll back shows that it runs, not the move\'s steps or time');
  assert.equal(adoptionView({ state: 'rolled_back' }).label, 'Rolled back');
  assert.match(rollbackCopy('succeeded'), /saved after the move is not in that snapshot/);
  assert.doesNotMatch(rollbackCopy('failed'), /saved after the move/);
});

test('transitions: what just ended, and when the panel shows the move', () => {
  assert.equal(adoptionEnded('running', 'succeeded'), 'succeeded');
  assert.equal(adoptionEnded('rolling_back', 'rolled_back'), 'rolled_back');
  assert.equal(adoptionEnded('running', 'failed'), 'failed');
  assert.equal(adoptionEnded(null, 'succeeded'), null, 'a finished move read on load is not news');
  assert.equal(adoptionEnded('running', 'running'), null);
  assert.equal(adoptionEnded('running', null), null);

  assert.equal(canStartAdoption(null, true), true);
  assert.equal(canStartAdoption(null, false), false, 'viewers never start one');
  assert.equal(canStartAdoption({ state: 'running' }, true), false);
  assert.equal(canStartAdoption({ state: 'rolled_back' }, true), true);
  assert.equal(canStartAdoption({ state: 'failed', rollback_available: true }, true), false, 'resume or roll back first');
  assert.equal(canStartAdoption({ state: 'failed', resume_available: false, rollback_available: false }, true), true, 'never a dead end');

  assert.equal(showAdoptionWhenReady(null), false);
  assert.equal(showAdoptionWhenReady({ state: 'succeeded', rollback_available: true }), true);
  assert.equal(showAdoptionWhenReady({ state: 'succeeded', rollback_available: false }), false);
  assert.equal(showAdoptionWhenReady({ state: 'succeeded', rollback_available: false }, { justMoved: true }), true);
  assert.equal(showAdoptionWhenReady({ state: 'rolling_back' }), true);
  assert.equal(showAdoptionWhenReady({ state: 'rolled_back' }), false);
});

test('a write\'s answer: its adoption, or the expected state until the next read', () => {
  assert.deepEqual(answeredAdoption({ ok: true, adoption: { id: 'a', state: 'running', steps: [] } }), { steps: [], error: null, rollback_available: false, id: 'a', state: 'running' });
  assert.equal(answeredAdoption({ ok: true }, 'rolling_back', { id: 'a', state: 'failed', error: 'x', rollback_available: true }).state, 'rolling_back');
  assert.equal(answeredAdoption({ ok: true }, 'running', { id: 'a', state: 'failed', error: 'x' }).error, null);
  assert.equal(answeredAdoption({ ok: true, adoption: { state: 'running' } }, 'running', { id: 'a', steps: [1] }).id, 'a', 'a partial answer keeps what was known');
});

test('step titles: the server\'s label, known names, else the name in words', () => {
  assert.equal(stepTitle('snapshot'), 'Take a snapshot');
  assert.equal(stepTitle('move_secrets'), 'Move secrets into encrypted storage');
  assert.equal(stepTitle('rewrite_env_file'), 'Rewrite env file');
  assert.equal(stepTitle('snapshot', 'Snapshot the guest'), 'Snapshot the guest');
  assert.equal(stepTitle(undefined), 'Step');
});
