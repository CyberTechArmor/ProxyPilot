// Harness guide — shipped-document integrity. Native-free on purpose: the
// guide file is read directly (no db.js import), so this suite runs in the
// fresh-checkout sandbox where better-sqlite3 is absent.
//
// The guide is the operator's map of every model-bearing pipeline step; these
// tests keep the shipped copy from silently losing a stage section or growing
// merge damage. Content accuracy is reviewed by humans — structure is what a
// machine can hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guide = readFileSync(new URL('../mock2/harness-guide.md', import.meta.url), 'utf8');

test('shipped harness guide is substantial', () => {
  assert.ok(guide.length > 10_000, `guide unexpectedly small (${guide.length} chars)`);
  assert.ok(guide.startsWith('# '), 'guide starts with a top-level title');
});

test('shipped harness guide covers every stage section', () => {
  const required = [
    '## How a step',            // resolution precedence
    '## The model slots',
    '## Stage 1 — Concept',
    '## Stage 2 — Define',
    '## Routing and classifiers',
    '## Stage 3 — Build',
    '## The free half',         // deterministic finish/verification
    '## Post-build',
    '## Where the money goes',
  ];
  for (const heading of required) {
    assert.ok(guide.includes(heading), `missing section: ${heading}`);
  }
});

test('shipped harness guide names the core control surfaces', () => {
  for (const term of [
    'concept_chat', 'build_runner', 'MOCK2_FAST_MODEL', 'MOCK2_PREPASS_MODEL',
    'lane tuning', 'callModelTurn',
  ]) {
    assert.ok(guide.includes(term), `missing term: ${term}`);
  }
});

test('shipped harness guide has no merge damage', () => {
  for (const marker of ['<<<<<<<', '>>>>>>>', '=======\n=======']) {
    assert.ok(!guide.includes(marker), `merge marker found: ${marker}`);
  }
});
