// Phase 1 of the Claude Agent SDK migration (docs/agent-sdk-migration.md): the
// pure decision + context-mapping layer for the SDK build runner. These are the
// only parts that can be unit-tested without the SDK's native binary, a real
// container, or a decryptable connector key — so they carry the guarantees:
//   - the flag defaults to the hand-rolled runner (flag-off must be unchanged), and
//   - the CLAUDE.md mapping carries the SAME governance content the hand-rolled
//     system prompt injects, so the constitution is sourced from context.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunnerMode, buildRunnerClaudeMd, buildRunnerSystemPrompt,
  SDK_ALLOWED_TOOLS,
} from '../mock2/runner-logic.js';

test('buildRunnerMode: defaults to hand-rolled when unset/empty/other', () => {
  assert.equal(buildRunnerMode({}), 'handrolled');
  assert.equal(buildRunnerMode({ BUILD_RUNNER: '' }), 'handrolled');
  assert.equal(buildRunnerMode({ BUILD_RUNNER: 'handrolled' }), 'handrolled');
  assert.equal(buildRunnerMode({ BUILD_RUNNER: 'legacy' }), 'handrolled');
  assert.equal(buildRunnerMode(), 'handrolled'); // no argument at all
});

test('buildRunnerMode: selects sdk only for BUILD_RUNNER=sdk (case/space tolerant)', () => {
  assert.equal(buildRunnerMode({ BUILD_RUNNER: 'sdk' }), 'sdk');
  assert.equal(buildRunnerMode({ BUILD_RUNNER: 'SDK' }), 'sdk');
  assert.equal(buildRunnerMode({ BUILD_RUNNER: '  sdk  ' }), 'sdk');
});

test('SDK_ALLOWED_TOOLS is the built-in read/edit/run set (no network tools)', () => {
  assert.deepEqual([...SDK_ALLOWED_TOOLS], ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']);
  assert.ok(!SDK_ALLOWED_TOOLS.includes('WebFetch'));
  assert.ok(!SDK_ALLOWED_TOOLS.includes('WebSearch'));
});

test('buildRunnerClaudeMd: carries the same governance content as the system prompt', () => {
  const constitution = 'CONSTITUTION-MARKER-42: no auth unless approved.';
  const skills = [
    { name: 'ts-express', description: 'scaffold conventions' },
    { name: 'design-fidelity', description: 'reproduce the mockup' },
  ];
  const md = buildRunnerClaudeMd({ constitution, skills, appDir: '/srv/app', webPort: 4321 });
  const sys = buildRunnerSystemPrompt({ constitution, skills, appDir: '/srv/app', webPort: 4321 });

  // The pinned constitution is present verbatim (sourced from context, not re-explored).
  assert.ok(md.includes(constitution));
  // The administrator-approved-exceptions override clause carries over — this is the
  // clause that makes an approved login-page deviation actually get built.
  assert.ok(md.includes('Administrator-approved exceptions'));
  assert.ok(md.includes('the approved exception WINS'));
  // Both skills are named, like the system prompt.
  assert.ok(md.includes('ts-express') && md.includes('design-fidelity'));
  // Design fidelity + run-contract guidance carry over.
  assert.ok(md.includes('state/design-tokens.json'));
  assert.ok(md.includes('mock2.yaml'));
  // The declared web port is threaded through both renderings.
  assert.ok(md.includes('4321') && sys.includes('4321'));
  // It is a CLAUDE.md (markdown doc), not the system-prompt text.
  assert.ok(md.startsWith('# Mock2 build runner'));
});

test('buildRunnerClaudeMd: does NOT run/approve gates itself (governance stays ours)', () => {
  const md = buildRunnerClaudeMd({ constitution: 'x' });
  // The SDK runner does not expose run_gates to the model — ProxyPilot runs the
  // battery after the loop, so the doc must not instruct the model to run them.
  assert.ok(/do not run or approve the gates yourself/i.test(md));
});

test('buildRunnerClaudeMd: tolerates empty framework content (R8 placeholder)', () => {
  const md = buildRunnerClaudeMd({});
  assert.ok(md.includes('placeholder constitution'));
  assert.ok(md.includes('(no skills configured in this framework version)'));
});
