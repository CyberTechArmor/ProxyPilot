// The design findings LEDGER — the thing that turns a critique into work.
//
// The post-build review already opened a browser, signed in, screenshotted the
// app and critiqued it. Then it posted the result to the chat and stopped: the
// after-build hook runs with apply=false, so no finding ever reached the next
// build. Three builds could receive the same critique and act on none of them.
//
// Native-free (risk R9): the ledger logic is pure; the container read/write is
// covered by the import check and the integration checklist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DESIGN_FINDINGS_PATH, MAX_BRIEFED_FINDINGS, STALE_AFTER_BUILDS,
  findingKey, matchFinding, SAME_FINDING_SIMILARITY,
  parseFindingsLedger, renderFindingsLedger, mergeFindings,
  openFindings, markBriefed, designFindingsSection, briefedKeys, ledgerDelta,
} from '../mock2/design-findings-logic.js';

const f = (screen, issue, extra = {}) => ({ screen, issue, severity: 'medium', fix: '', ...extra });

test('the same defect described twice is one finding, not two', () => {
  // The review is a model, and it does not phrase the same defect identically
  // on two runs — the second look adds a clause or leads with the consequence.
  // ANY text-derived key therefore reports the repeat as new, which is why
  // matching is similarity rather than equality. This is the exact pair that
  // caught it: a key built from the leading words scored them as two findings.
  const first = f('/shifts', 'KPI tiles are decorative');
  const reworded = f('/shifts/', 'The KPI tiles are decorative and do nothing when tapped');
  const row = { ...first, key: findingKey(first) };
  assert.ok(matchFinding([row], reworded), 'a reworded repeat must match');

  // Different screens are different findings even with identical wording.
  assert.equal(matchFinding([{ ...row, screen: '/staff' }], { ...first, screen: '/shifts' }), null);
  // And an unrelated defect on the SAME screen is not swallowed.
  assert.equal(matchFinding([row], f('/shifts', 'The date column truncates mid-month')), null);
  assert.ok(SAME_FINDING_SIMILARITY > 0 && SAME_FINDING_SIMILARITY <= 1);
  // A missing screen is the root, not undefined.
  assert.match(findingKey({ issue: 'x' }), /^\/::/);
});

test('a finding raised again is counted, not duplicated', () => {
  let ledger = { findings: [] };
  ledger = mergeFindings(ledger, [f('/shifts', 'KPI tiles are decorative')], { cycleId: 1 });
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.findings[0].timesSeen, 1);

  // Same defect, the model's second phrasing, plus something new.
  ledger = mergeFindings(ledger, [
    f('/shifts', 'The KPI tiles are decorative and do nothing when tapped'),
    f('/staff', 'Empty cells render blank instead of an em dash'),
  ], { cycleId: 2 });
  assert.equal(ledger.findings.length, 2);
  const kpi = ledger.findings.find((x) => x.screen === '/shifts');
  assert.equal(kpi.timesSeen, 2, 'a repeat bumps the count');
  assert.equal(kpi.firstSeenCycle, 1, 'history survives the rewording');
  assert.equal(kpi.lastSeenCycle, 2);
  assert.match(kpi.issue, /and do nothing when tapped/, 'the newest wording describes the app now');
});

test('a finding the latest review no longer raises resolves itself', () => {
  // Nobody is going to tick these off by hand. The review looked at the same
  // screens with the same eyes; if it no longer says this, it is no longer
  // true — and a ledger that only ever grows is one nobody reads.
  let ledger = mergeFindings({ findings: [] }, [
    f('/shifts', 'KPI tiles are decorative'),
    f('/staff', 'Empty cells render blank'),
  ], { cycleId: 1 });
  ledger = mergeFindings(ledger, [f('/staff', 'Empty cells render blank')], { cycleId: 2 });

  assert.equal(openFindings(ledger).length, 1);
  assert.equal(openFindings(ledger)[0].screen, '/staff');
  assert.equal(ledger.findings.find((x) => x.screen === '/shifts').status, 'resolved');

  // And a defect that comes BACK reopens with its history rather than starting over.
  ledger = mergeFindings(ledger, [f('/shifts', 'KPI tiles are decorative'), f('/staff', 'Empty cells render blank')], { cycleId: 3 });
  const back = ledger.findings.find((x) => x.screen === '/shifts');
  assert.equal(back.status, 'open');
  assert.equal(back.timesSeen, 2);
  assert.equal(back.firstSeenCycle, 1);
});

test('open findings ride the next build worst-and-most-ignored first', () => {
  const ledger = mergeFindings({ findings: [] }, [
    f('/a', 'low thing', { severity: 'low' }),
    f('/b', 'high thing', { severity: 'high' }),
    f('/c', 'medium thing', { severity: 'medium' }),
  ], { cycleId: 1 });
  assert.deepEqual(openFindings(ledger).map((x) => x.screen), ['/b', '/c', '/a']);

  // Within a severity, the one the app keeps shipping goes first.
  const repeated = mergeFindings(ledger, [
    f('/a', 'low thing', { severity: 'low' }),
    f('/d', 'other low thing', { severity: 'low' }),
    f('/b', 'high thing', { severity: 'high' }),
    f('/c', 'medium thing', { severity: 'medium' }),
  ], { cycleId: 2 });
  const lows = openFindings(repeated).filter((x) => x.severity === 'low');
  assert.equal(lows[0].screen, '/a', 'the repeated low outranks the fresh one');

  const section = designFindingsSection(openFindings(repeated));
  assert.match(section, /Open design findings/);
  assert.match(section, /\[raised on 2 reviews\]/, 'the count is what makes a repeat legible');
  assert.match(section, /do not treat this as the task/, 'subordinate to the instruction');
  // A clean app pays nothing for this.
  assert.equal(designFindingsSection([]), '');
  assert.equal(designFindingsSection(null), '');
});

test('a task turn is bounded even when the ledger is not', () => {
  const many = Array.from({ length: 30 }, (_, i) => f(`/screen-${i}`, `issue number ${i}`, { severity: 'high' }));
  const ledger = mergeFindings({ findings: [] }, many, { cycleId: 1 });
  assert.equal(openFindings(ledger).length, 30, 'the ledger is the record');
  const lines = designFindingsSection(openFindings(ledger)).split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, MAX_BRIEFED_FINDINGS, 'the task turn is not');
  assert.equal(briefedKeys(openFindings(ledger)).length, MAX_BRIEFED_FINDINGS);
});

test('a finding no build will act on stops costing every build', () => {
  // Not because it stopped being true — because a line that has ridden eight
  // builds unchanged teaches nobody anything and is paid for every time.
  let ledger = mergeFindings({ findings: [] }, [f('/x', 'stubborn thing')], { cycleId: 1 });
  for (let i = 0; i < STALE_AFTER_BUILDS - 1; i++) {
    ledger = markBriefed(ledger, briefedKeys(openFindings(ledger)));
    assert.equal(openFindings(ledger).length, 1, `still briefed after ${i + 1} builds`);
  }
  ledger = markBriefed(ledger, briefedKeys(openFindings(ledger)));
  assert.equal(openFindings(ledger).length, 0, 'it stops riding the task turn');
  assert.equal(ledger.findings[0].status, 'stale');
  assert.equal(ledger.findings[0].buildsBriefed, STALE_AFTER_BUILDS);
  // Still in the ledger, so an operator can see it.
  assert.equal(ledger.findings.length, 1);
});

test('an unreadable ledger means "nothing open", never a thrown build', () => {
  // A project that predates the ledger, a truncated write, an operator who was
  // reading the file — all ordinary, and none of them may fail a build.
  for (const bad of ['', null, undefined, 'not json', '{"findings":', '{"findings":{}}', '[]']) {
    assert.deepEqual(parseFindingsLedger(bad), { findings: [] }, `${JSON.stringify(bad)} parses to empty`);
  }
  // Hand-edited rows are repaired rather than trusted.
  const repaired = parseFindingsLedger(JSON.stringify({ findings: [
    { issue: 'kept', severity: 'catastrophic', timesSeen: -5, status: 'invented' },
    { issue: '   ' },
    'not an object',
  ] }));
  assert.equal(repaired.findings.length, 1);
  assert.equal(repaired.findings[0].severity, 'medium');
  assert.equal(repaired.findings[0].timesSeen, 1);
  assert.equal(repaired.findings[0].status, 'open');
  assert.ok(repaired.findings[0].key, 'a row with no key gets one derived');
});

test('the ledger round-trips through the file it is stored in', () => {
  const ledger = mergeFindings({ findings: [] }, [f('/a', 'one'), f('/b', 'two', { severity: 'high' })], { cycleId: 7 });
  assert.deepEqual(parseFindingsLedger(renderFindingsLedger(ledger)), ledger);
  assert.match(renderFindingsLedger(ledger), /\n$/, 'a state file ends with a newline');
});

test('the operator is told whether anything moved', () => {
  // Reading the same three findings after every build with no idea whether the
  // last one fixed anything is how a review stops being read at all.
  const before = mergeFindings({ findings: [] }, [f('/a', 'one'), f('/b', 'two')], { cycleId: 1 });
  const after = mergeFindings(before, [f('/b', 'two'), f('/c', 'three')], { cycleId: 2 });
  const note = ledgerDelta(before, after);
  assert.match(note, /1 new/);
  assert.match(note, /1 still open from an earlier review/);
  assert.match(note, /1 fixed since the last review/);
  // Nothing to say stays silent.
  assert.equal(ledgerDelta({ findings: [] }, { findings: [] }), '');
});

test('the ledger is wired into BOTH runners and the review that writes it', () => {
  // The pure layer above is worth nothing if nothing calls it. Two runners
  // exist (hand-rolled and SDK) and a change that reaches one of them is the
  // shape of half-fix this codebase has shipped before.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (f2) => readFileSync(path.join(here, '..', 'mock2', f2), 'utf8');
  for (const runner of ['runner.js', 'runner-sdk.js']) {
    const src = read(runner);
    assert.match(src, /buildDesignFindingsBrief/, `${runner} must brief the build`);
    assert.match(src, /markDesignFindingsBriefed/, `${runner} must record that it did`);
  }
  const review = read('design-review.js');
  assert.match(review, /mergeFindings/, 'the review must merge into the ledger');
  assert.match(review, /writeContainerFile\(containerName, DESIGN_FINDINGS_PATH/, 'and persist it');
  // The build is told the file exists and that it is read-only to it.
  const prompt = read('runner-logic.js');
  assert.ok(prompt.includes(DESIGN_FINDINGS_PATH), 'the runner prompt must name the ledger');
  assert.match(prompt, /read\s+it, never write it/i);
});
