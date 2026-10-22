// Task continuity — the build chat's task strip words and the routed-answer
// rules (src/components/mock2/task-strip-logic.js). Pure; no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeTask, taskDetails, routedOf, routedNoteText, routedRefreshesParent, ROUTED_WORK_STARTED,
} from '../src/components/mock2/task-strip-logic.js';

const task = (over = {}) => ({
  key: 't12-add-invoice-export', id: 12, intent: 'build', status: 'interrupted', unfinished: true,
  goal: 'Add invoice export', request_id: 34, last_cycle_id: 88, live: false, resumed: false, can_resume: true,
  last_verified_step: 'Checkpoint 1a2b3c4 committed', next_step: 'Resume from the last checkpoint',
  remaining: [], blockers: [], uncertain: [], checks: [], completed_steps: [],
  files: { task_json: 'state/tasks/t12-add-invoice-export/task.json', handoff_md: 'state/tasks/t12-add-invoice-export/handoff.md' },
  ...over,
});

test('nothing is shown for no task, a stopped one or a completed one', () => {
  assert.equal(describeTask(null), null);
  assert.equal(describeTask(task({ status: 'stopped' })), null);
  assert.equal(describeTask(task({ status: 'completed' })), null);
  assert.equal(describeTask(task({ status: 'mystery' })), null);
});

test('live states name the work and offer no buttons', () => {
  const building = describeTask(task({ status: 'active', live: true }));
  assert.equal(`${building.label}: ${building.subject}`, 'Building: Add invoice export');
  assert.equal(building.resumeLabel, null);
  assert.equal(building.stop, null);
  const resuming = describeTask(task({ status: 'active', live: true, resumed: true }));
  assert.equal(`${resuming.label}: ${resuming.subject}`, 'Resuming build: Add invoice export');
  const investigating = describeTask(task({ intent: 'investigation', status: 'active', live: true, goal: 'Why is login slow' }));
  assert.equal(`${investigating.label}: ${investigating.subject}`, 'Investigating: Why is login slow');
  // A live task never lists "Will check first" — the check happens on resume.
  assert.deepEqual(describeTask(task({ status: 'active', live: true, uncertain: ['x'] })).checkFirst, []);
});

test('interrupted: next step, Resume and Stop, and what will be checked first', () => {
  const v = describeTask(task({ uncertain: ['Check whether the deploy completed before repeating it'] }));
  assert.equal(`${v.label}: ${v.subject}`, 'Interrupted: Add invoice export');
  assert.equal(v.detail, 'Next: Resume from the last checkpoint');
  assert.equal(v.resumeLabel, 'Resume');
  assert.equal(v.stop, 'row');
  assert.deepEqual(v.checkFirst, ['Check whether the deploy completed before repeating it']);
  assert.equal(describeTask(task({ can_resume: false })).resumeLabel, null);
});

test('failed: "Stopped with an error" with Try again; Stop only inside the details', () => {
  const v = describeTask(task({ status: 'failed', blockers: ['npm ERR! missing script: build'] }));
  assert.equal(`${v.label}: ${v.subject}`, 'Stopped with an error: Add invoice export');
  assert.equal(v.detail, 'npm ERR! missing script: build');
  assert.equal(v.resumeLabel, 'Try again');
  assert.equal(v.stop, 'details');
});

test('blocked: resumable names the first blocker; otherwise it waits on the person', () => {
  const b = describeTask(task({ status: 'blocked', can_resume: true, blockers: ['Over budget', 'second'] }));
  assert.equal(`${b.label}: ${b.subject}`, 'Blocked: Over budget');
  assert.equal(b.detail, 'Add invoice export');
  assert.equal(b.resumeLabel, 'Resume');
  const w = describeTask(task({ status: 'blocked', can_resume: false, blockers: ['Waiting for answers to open questions'] }));
  assert.equal(`${w.label}: ${w.subject}`, 'Waiting on you: Add invoice export');
  assert.equal(w.resumeLabel, null);
  assert.equal(w.show, true);
  assert.equal(w.stop, null);
});

test('details: bounded, empty sections dropped, folder from the task file path', () => {
  const steps = Array.from({ length: 9 }, (_, i) => ({ step: `Step ${i + 1}`, at: '2026-10-21T10:00:00Z' }));
  const d = taskDetails(task({ completed_steps: steps, checks: [{ key: 'typecheck', status: 'passed' }, { status: 'x' }] }));
  assert.deepEqual(d.done, ['Step 5', 'Step 6', 'Step 7', 'Step 8', 'Step 9']);
  assert.deepEqual(d.checks, [{ key: 'typecheck', status: 'passed' }]);
  assert.equal(d.folder, 'state/tasks/t12-add-invoice-export/');
  assert.equal(d.any, true);
  assert.equal(taskDetails({ goal: 'x' }).any, false);
});

test('routed answers are recognised by their presence and always explained', () => {
  assert.equal(routedOf({ split_proposal: {} }), null);
  assert.equal(routedOf(null), null);
  const routed = routedOf({ routed: { action: 'resume_build', task: null, note: 'Resuming build: Add invoice export' } });
  assert.equal(routedNoteText(routed), 'Resuming build: Add invoice export');
  assert.equal(routedNoteText({ action: 'nothing_to_stop', note: '' }), 'Nothing is running to stop.');
  assert.equal(routedNoteText({ action: 'unknown' }), 'Done');
  for (const a of ['resume_build', 'continue_investigation', 'investigate']) assert(ROUTED_WORK_STARTED.has(a));
  for (const a of ['resume_build', 'attach', 'stop_build']) assert.equal(routedRefreshesParent(a), true);
  for (const a of ['nothing_to_stop', 'answer_required', 'stop_task']) assert.equal(routedRefreshesParent(a), false);
});
