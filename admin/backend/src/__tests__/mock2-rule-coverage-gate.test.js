// RULE-COVERAGE GATE — an empty rule set used to be a vacuous PASS (run-taxonomy
// fix #4/C2). `rules_touched` was null in every change record ever written and
// state/rules.md was the same empty stub on 11 of 11 fleet projects, so this
// gate exited 0 twice over and never once caught it. These tests run the REAL
// gate script (from the pinned framework-seed/gates.json) under sh, against a
// real working directory, and pin: missing rules.md fails; zero confirmed rules
// fails; both failures name Define as the remedy; a project that HAS covered
// rules still passes. The first two are regression fixtures — they failed on
// the pre-fix tree (both paths used to `exit 0`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const gates = JSON.parse(readFileSync(new URL('../mock2/framework-seed/gates.json', import.meta.url), 'utf8'));
const SCRIPT = (Array.isArray(gates) ? gates : gates.gates).find((g) => g.name === 'rule-coverage').script;

function dirWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-rulegate-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function runGate(dir) {
  const f = join(dir, 'gate.sh');
  writeFileSync(f, SCRIPT);
  const r = spawnSync('sh', [f], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ---- source-level: the vacuous exits are gone ----

test('rule-coverage: the script no longer contains either vacuous "skipped"/"nothing to cover" exit 0', () => {
  assert.doesNotMatch(SCRIPT, /no state\/rules\.md yet; skipped/);
  assert.doesNotMatch(SCRIPT, /no confirmed rules yet; nothing to cover/);
});

test('both failure messages name Define as the remedy', () => {
  const failLines = SCRIPT.split('\n').filter((l) => /FAIL/.test(l));
  assert.equal(failLines.length, 3, 'two coverage failures + the existing test-count failure');
  const coverageFails = failLines.filter((l) => /confirmed rules/.test(l));
  assert.equal(coverageFails.length, 2);
  for (const line of coverageFails) assert.match(line, /Define/i, `must name Define as the remedy: ${line}`);
});

// ---- execution: real fail/pass behavior (regression fixtures) ----

test('rule-coverage fails when state/rules.md is missing', () => {
  const dir = dirWith({});
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL/);
    assert.match(r.out, /Define/i);
    assert.doesNotMatch(r.out, /skipped/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rule-coverage fails when rules.md has zero rule-qN anchors', () => {
  const dir = dirWith({ 'state/rules.md': '# Project rules\n\nNo confirmed rules here, just prose.\n' });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL/);
    assert.match(r.out, /Define/i);
    assert.doesNotMatch(r.out, /nothing to cover/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rule-coverage still passes when rules are covered by tests', () => {
  const dir = dirWith({
    'state/rules.md': [
      '# Project rules',
      '',
      '## Bookings cannot overlap',
      '<!-- rule-q1 -->',
      '',
      '**Answer:** No, two bookings cannot overlap for the same room.',
      '',
      '## Deletes require confirmation',
      '<!-- rule-q2 -->',
      '',
      '**Answer:** Yes, always confirm before delete.',
      '',
    ].join('\n'),
    'src/bookings.test.js': "it('rejects overlapping bookings', () => {});\ntest('deletes require confirmation', () => {});\n",
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /rule-coverage: OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rule-coverage still fails on under-covered rules (unchanged third check)', () => {
  const dir = dirWith({
    'state/rules.md': '# Project rules\n\n## A rule\n<!-- rule-q1 -->\n\n**Answer:** yes\n\n## Another rule\n<!-- rule-q2 -->\n\n**Answer:** yes\n',
    'src/bookings.test.js': "it('only one covering test', () => {});\n",
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL — 2 confirmed rule\(s\) but only 1 test block\(s\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
