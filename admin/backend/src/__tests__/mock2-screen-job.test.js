// SCREEN WORK PROGRESS — the record that makes a two-minute capture visible.
//
// "Please show the screen check, as it's doing work, in the preview sections.
//  Please also fix as the screen check, I had to refresh the page for it show
//  up."
//
// Both halves of that are one missing fact. The chat polls while a BUILD cycle
// is live, an ask is streaming, or a rule question is open. A screen check is
// none of those — it is a browser driving the app with no cycle and no ask job
// — so nothing refreshed, and for the whole capture the product showed no sign
// of working at all.
//
// This is the record both fixes read: the chat keeps polling while it is
// active, and the preview shows what it says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getScreenJob, startScreenJob, updateScreenJob, finishScreenJob, screenJobActive,
  setScreenFrame, getScreenFrame,
  _resetScreenJobs, _ageScreenJob, SCREEN_JOB_KINDS, SCREEN_JOB_MAX_AGE_MS, SCREEN_JOB_DONE_TTL_MS,
} from '../mock2/screen-job.js';

test('a started job is active and carries a human message', (t) => {
  t.after(_resetScreenJobs);
  const job = startScreenJob(7, 'review');
  assert.equal(job.label, SCREEN_JOB_KINDS.review);
  assert.equal(screenJobActive(7), true);
  assert.match(getScreenJob(7).message, /Screen check/);
});

test('progress replaces the message and keeps the job active', (t) => {
  t.after(_resetScreenJobs);
  startScreenJob(7, 'options');
  updateScreenJob(7, { phase: 'capturing', message: 'Screenshotting `/notes` at phone and laptop width…' });
  const j = getScreenJob(7);
  assert.equal(j.label, SCREEN_JOB_KINDS.options);
  assert.equal(j.phase, 'capturing');
  // Written for somebody watching a picture of their app, not for a log.
  assert.match(j.message, /Screenshotting/);
  assert.equal(screenJobActive(7), true);
});

test('finishing stops the polling but stays readable for a beat', (t) => {
  t.after(_resetScreenJobs);
  startScreenJob(7, 'review');
  finishScreenJob(7, { ok: true, message: 'Screen check finished — 6 screenshot(s) are in the chat.' });
  assert.equal(screenJobActive(7), false, 'the chat must stop polling once there is nothing to wait for');
  assert.equal(getScreenJob(7).phase, 'done', 'and still be readable, so the spinner does not simply vanish');
  assert.match(getScreenJob(7).message, /6 screenshot/);
});

test('a failure says so rather than disappearing', (t) => {
  t.after(_resetScreenJobs);
  startScreenJob(7, 'review');
  finishScreenJob(7, { ok: false, message: 'Could not screenshot the app.' });
  assert.equal(getScreenJob(7).phase, 'failed');
  assert.equal(screenJobActive(7), false);
});

test('jobs are per project', (t) => {
  t.after(_resetScreenJobs);
  startScreenJob(7, 'review');
  assert.equal(getScreenJob(8), null);
  assert.equal(screenJobActive(8), false);
  // Numeric and string ids are the same project — the route passes a string.
  assert.ok(getScreenJob('7'));
});

test('A STALE JOB EXPIRES RATHER THAN SPINNING FOREVER', (t) => {
  // The record is in-memory, so a backend restart or a crash inside the browser
  // driver leaves it mid-flight with nobody to finish it. A spinner over the
  // preview for work that is not happening is worse than no spinner at all, so
  // age is checked on READ — nothing to schedule, nothing to leak.
  t.after(_resetScreenJobs);
  startScreenJob(7, 'review');
  _ageScreenJob(7, SCREEN_JOB_MAX_AGE_MS + 1000);
  assert.equal(getScreenJob(7), null);
  assert.equal(screenJobActive(7), false);
});

test('a finished job expires much sooner than a running one', (t) => {
  t.after(_resetScreenJobs);
  startScreenJob(7, 'review');
  finishScreenJob(7, { ok: true });
  _ageScreenJob(7, SCREEN_JOB_DONE_TTL_MS + 1000);
  assert.equal(getScreenJob(7), null);
  assert.ok(SCREEN_JOB_DONE_TTL_MS < SCREEN_JOB_MAX_AGE_MS);
});

test('pressing twice replaces the record rather than stacking', (t) => {
  t.after(_resetScreenJobs);
  startScreenJob(7, 'review');
  updateScreenJob(7, { phase: 'capturing' });
  const second = startScreenJob(7, 'options');
  assert.equal(second.phase, 'starting');
  assert.equal(getScreenJob(7).label, SCREEN_JOB_KINDS.options, 'the second press is the one being waited on');
});

test('updating or finishing a job that does not exist is harmless', () => {
  _resetScreenJobs();
  assert.equal(updateScreenJob(99, { phase: 'x' }), null);
  assert.equal(finishScreenJob(99, { ok: true }), null);
  assert.equal(getScreenJob(99), null);
});

test('RATCHET: the chat payload carries the screen job, and the chat polls on it', async () => {
  // Two files, one fact. The backend can report progress perfectly and the chat
  // still not refresh, which is the exact bug: the record existed nowhere and
  // `shouldPoll` had no term for it.
  const { readFileSync } = await import('node:fs');
  const routes = readFileSync(new URL('../mock2/routes.js', import.meta.url), 'utf8');
  assert.match(routes, /screen_job: getScreenJob\(project\.id\)/, 'the chat payload must carry it');
  assert.match(routes, /projects\/:id\/screen-job/, 'and the preview needs a light endpoint of its own');

  const chat = readFileSync(new URL('../../../frontend/src/components/mock2/BuildChat.jsx', import.meta.url), 'utf8');
  assert.match(chat, /const screenActive = /);
  assert.match(
    chat,
    /shouldPoll = active \|\| askActive \|\| screenActive/,
    'without this term the operator has to refresh the page by hand — which is what was reported',
  );
});

test('RATCHET: both browser-driving runs report progress', async () => {
  // Design options shipped the same week and drives the same browser for the
  // same two minutes. A progress record on only one of them is the same
  // complaint again, one feature later.
  const { readFileSync } = await import('node:fs');
  for (const mod of ['design-review.js', 'design-options.js']) {
    const src = readFileSync(new URL(`../mock2/${mod}`, import.meta.url), 'utf8');
    assert.match(src, /startScreenJob\(/, `${mod} must start a progress record`);
    assert.match(src, /finishScreenJob\(/, `${mod} must finish it — a record nobody closes spins until it expires`);
    // Every failure path too: the ones that return early are exactly the runs
    // an operator is left staring at.
    assert.ok(/finishScreenJob\([^)]*ok: false/.test(src), `${mod} must close the record when it FAILS`);
  }
});

// A one-pixel JPEG is enough: what is under test is the transport, not the image.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

test('THE FRAME BYTES NEVER RIDE THE STATUS PAYLOAD', (t) => {
  // The status is polled every couple of seconds. A 200KB JPEG in it would be
  // paid for on every tick whether or not the picture had changed — so the
  // status carries a sequence number and the bytes come from their own
  // endpoint, fetched only when that number moves.
  t.after(_resetScreenJobs);
  startScreenJob(7, 'review');
  setScreenFrame(7, { data: JPEG, path: '/admin', width: 390 });
  const status = getScreenJob(7);
  assert.equal(status.frame, undefined, 'the bytes must not be in the polled payload');
  assert.equal(status.frameSeq, 1);
  assert.equal(status.framePath, '/admin');
  assert.equal(status.frameWidth, 390);
  const frame = getScreenFrame(7);
  assert.ok(Buffer.isBuffer(frame.buffer));
  assert.equal(frame.seq, 1);
});

test('each shot advances the sequence, so the preview knows to refetch', (t) => {
  t.after(_resetScreenJobs);
  startScreenJob(7, 'review');
  setScreenFrame(7, { data: JPEG, path: '/', width: 390 });
  setScreenFrame(7, { data: JPEG, path: '/', width: 1280 });
  setScreenFrame(7, { data: JPEG, path: '/admin', width: 390 });
  const j = getScreenJob(7);
  assert.equal(j.frameSeq, 3);
  assert.equal(j.shots, 3, 'the count the operator sees is the count of frames taken');
  assert.equal(j.framePath, '/admin', 'and the caption follows the latest frame');
});

test('a frame for a job that is gone is not served', (t) => {
  t.after(_resetScreenJobs);
  assert.equal(setScreenFrame(9, { data: JPEG }), null, 'no job, nothing to attach it to');
  assert.equal(getScreenFrame(9), null);
  startScreenJob(7, 'review');
  assert.equal(getScreenFrame(7), null, 'a job with no frame yet serves nothing rather than a stale one');
});

test('an expired job takes its frame with it', (t) => {
  // The bytes are the largest thing here; leaving them readable after the job
  // has aged out would show a picture of work that finished ten minutes ago.
  t.after(_resetScreenJobs);
  startScreenJob(7, 'review');
  setScreenFrame(7, { data: JPEG, path: '/', width: 390 });
  _ageScreenJob(7, SCREEN_JOB_MAX_AGE_MS + 1000);
  assert.equal(getScreenFrame(7), null);
  assert.equal(getScreenJob(7), null);
});

test('RATCHET: the capture reports every shot as it lands', async () => {
  // Without onShot the viewfinder has nothing to show and the preview is back
  // to a spinner — which is the complaint, one release later.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mock2/design-review.js', import.meta.url), 'utf8');
  assert.match(src, /captureAppScreens\(\{[^}]*onShot/s, 'the capture must accept a per-shot callback');
  // Both widths, not just the first: a review that reports only the phone shot
  // freezes the viewfinder halfway through every run.
  assert.equal((src.match(/\breport\(\w+Entry\)/g) || []).length, 2, 'mobile AND desktop shots must report');
  // And a viewfinder that throws must never cost the review it decorates.
  assert.match(src, /try \{ onShot\?\.\(shot\); \} catch/);
  for (const mod of ['design-review.js', 'design-options.js']) {
    const m = readFileSync(new URL(`../mock2/${mod}`, import.meta.url), 'utf8');
    assert.match(m, /setScreenFrame\(/, `${mod} must stream its frames to the preview`);
  }
});

test('RATCHET: the preview locks its controls while a capture runs', async () => {
  // "for that period to be locked from navigating until it finishes". The
  // overlay covers the frame, but the toolbar sits above it — Desktop/Mobile,
  // reload and Annotate all still reachable unless they are disabled too.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../../frontend/src/components/mock2/ProjectPreview.jsx', import.meta.url), 'utf8');
  assert.match(src, /active: screenBusy/, 'the panel must know a capture is running');
  assert.match(src, /ScreenWorkViewfinder/, 'and show the frames over the preview');
  assert.ok((src.match(/disabled=\{screenBusy\}/g) || []).length >= 4,
    'reload, Desktop, Mobile and Annotate must all be locked for the duration');
});
