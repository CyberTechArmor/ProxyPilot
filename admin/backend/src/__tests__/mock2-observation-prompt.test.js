// Runtime observation prompt guidance (run-taxonomy fix #1/B1).
//
// Scope correction versus the original spec draft: OBSERVATION_SECTION rides
// ONLY buildRunnerSystemPrompt (the hand-rolled ProxyPilot harness), NOT
// buildRunnerClaudeMd (the Claude Agent SDK harness, runner-sdk.js). Verified
// against the source before writing these tests: EDITING_MECHANICS_SECTION —
// the section OBSERVATION_SECTION sits beside — is likewise NOT referenced by
// buildRunnerClaudeMd at all (that harness gets its own "## How to work"
// section instead, because the SDK provides its own built-in Read/Edit/Write
// tools rather than the hand-rolled RUNNER_TOOLS contract). More fundamentally,
// http_probe/browser_probe are entries in RUNNER_TOOLS, which runner-sdk.js
// never touches (its own header comment: it replaces "the hand-rolled turn
// loop over RUNNER_TOOLS" with the SDK's own query() tool set) — so telling
// the SDK-driven model about tools it does not have would be actively
// misleading, not merely undrifted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSERVATION_SECTION, buildRunnerSystemPrompt, buildRunnerClaudeMd, RUNNER_TOOLS,
} from '../mock2/runner-logic.js';

test('OBSERVATION_SECTION rides buildRunnerSystemPrompt (the hand-rolled harness that owns these tools)', () => {
  const sys = buildRunnerSystemPrompt({ constitution: 'C', buildMode: 'full' });
  assert.ok(sys.includes(OBSERVATION_SECTION), 'system prompt carries it verbatim');
});

test('OBSERVATION_SECTION does NOT ride buildRunnerClaudeMd (the SDK harness has no http_probe/browser_probe tools)', () => {
  const md = buildRunnerClaudeMd({ constitution: 'C' });
  assert.ok(!md.includes(OBSERVATION_SECTION), 'the SDK prompt must not reference tools it does not have');
  assert.doesNotMatch(md, /http_probe|browser_probe/);
});

test('the prompt no longer forbids probing the running app', () => {
  const sys = buildRunnerSystemPrompt({ constitution: 'C', buildMode: 'full' });
  // REGRESSION FIXTURE: before this fix, the prompt explicitly told the model
  // not to do this at all ("do not write throwaway curl/psql round-trips to
  // prove the app works end to end") with no carve-out for a sanctioned tool.
  // "do not boot the server by hand" survives (an existing test pins it — it
  // still correctly forbids hand-rolling a shell-level boot), but it must now
  // be explicitly distinguished from the probe tools' own restart.
  assert.doesNotMatch(sys, /do not write throwaway curl/i);
  assert.match(sys, /do not boot the server by hand/i);
  assert.match(sys, /not the same as booting it by hand/i);
  assert.match(sys, /http_probe/);
  assert.match(sys, /browser_probe/);
});

test('the prompt still forbids hand-rolling a whole integration harness (the P47-adjacent lesson survives the rewrite)', () => {
  const sys = buildRunnerSystemPrompt({ constitution: 'C', buildMode: 'full' }).replace(/\s+/g, ' ');
  assert.match(sys, /do not create scratch databases/);
  assert.match(sys, /do not mint your own auth tokens/);
});

test('"Verified" now also covers a direct observation, not only reading source', () => {
  const sys = buildRunnerSystemPrompt({ constitution: 'C', buildMode: 'full' }).replace(/\s+/g, ' ');
  assert.match(sys, /It does not mean you booted the app/); // the existing pinned phrase survives
  assert.match(sys, /except through http_probe or browser_probe/);
  assert.match(sys, /name what you saw \(a status code, a computed style, a console error\)/);
});

test('RUNNER_TOOLS is what the observation section actually describes: http_probe and browser_probe exist', () => {
  const names = RUNNER_TOOLS.map((t) => t.name);
  assert.ok(names.includes('http_probe'));
  assert.ok(names.includes('browser_probe'));
});
