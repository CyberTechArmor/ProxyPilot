// Failure diagnosis — the pure halves (diagnose-logic.js): which checks and
// files count as evidence, the evidence document's shape, and the chat
// message the diagnosis lands as. The orchestration (runner.runFailureDiagnosis)
// is container + model work and stays out of unit tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  failingAppChecks, diagnosisCandidateFiles, diagnosisEvidence, diagnosisChatMessage,
  DIAGNOSIS_SYSTEM_PROMPT,
} from '../mock2/diagnose-logic.js';

const REPORT = {
  browser: {
    ok: false,
    uiChecks: [
      { id: 'ok-check', name: 'passes', ok: true, baseline: false, steps: [] },
      {
        id: 'notes-export-menu-opens', name: 'Export menu opens', ok: false, baseline: false,
        steps: [
          { kind: 'click', selector: '#editor-export', ok: true, detail: 'clicked' },
          { kind: 'expect_visible', selector: '#export-menu', ok: false, detail: 'Timeout 5000ms exceeded.' },
        ],
        consoleErrors: ['TypeError: boom'],
      },
      { id: 'platform-baseline-signin-legal', name: 'platform', ok: false, baseline: true, steps: [] },
    ],
  },
};

test('failingAppChecks: app-owned failures only — passing and baseline checks are not evidence', () => {
  const checks = failingAppChecks(REPORT);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, 'notes-export-menu-opens');
  assert.equal(checks[0].steps[1].ok, false);
  assert.deepEqual(checks[0].consoleErrors, ['TypeError: boom']);
  assert.deepEqual(failingAppChecks(null), []);
  assert.deepEqual(failingAppChecks({ browser: { uiChecks: [] } }), []);
});

test('diagnosisCandidateFiles: product files from the diff, artifacts and state excluded', () => {
  const files = diagnosisCandidateFiles([
    'public/notes.js', 'public/build-id.js', 'public/build-id.txt', 'public/sw.js',
    'state/db/snapshot.sql', 'package-lock.json', 'src/notes/export.ts',
  ]);
  assert.deepEqual(files, ['public/notes.js', 'src/notes/export.ts']);
  // Bounded — the diagnosis call must stay in its price band.
  const many = diagnosisCandidateFiles(Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`), { max: 6 });
  assert.equal(many.length, 6);
});

test('diagnosisEvidence: instruction, claim, failing step, and file contents — all bounded', () => {
  const text = diagnosisEvidence({
    instruction: 'fix the export button',
    finishSummary: 'Fixed the editor Export action',
    checks: failingAppChecks(REPORT),
    files: [{ path: 'public/notes.js', content: 'x'.repeat(30000) }],
  });
  assert.match(text, /FAILED BUILD/);
  assert.match(text, /claimed on finishing/);
  assert.match(text, /notes-export-menu-opens/);
  assert.match(text, /#export-menu → FAILED \(Timeout 5000ms exceeded\.\)/);
  assert.match(text, /FILE public\/notes\.js/);
  // The 30k file is clipped to its 24k budget.
  assert.ok(text.length < 27000);
});

test('diagnosis prompt demands root cause + a build-ready fix, and the chat message carries it', () => {
  assert.match(DIAGNOSIS_SYSTEM_PROMPT, /ROOT CAUSE/);
  assert.match(DIAGNOSIS_SYSTEM_PROMPT, /FIX INSTRUCTION/);
  assert.match(DIAGNOSIS_SYSTEM_PROMPT, /Smallest\ncorrect fix|Smallest correct fix/);
  const msg = diagnosisChatMessage('ROOT CAUSE: the click-away handler...', { model: 'claude-opus-5' });
  assert.match(msg, /\*\*Build diagnosis\*\*/);
  assert.match(msg, /claude-opus-5/);
  assert.match(msg, /Quick update/);
  assert.equal(diagnosisChatMessage('', {}), null);
});
