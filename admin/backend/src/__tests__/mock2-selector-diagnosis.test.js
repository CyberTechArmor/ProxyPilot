// SELECTOR DIAGNOSIS — "Timeout 5000ms exceeded" is not a diagnosis.
//
// Project 47, three cycles, $10.28, on this line:
//
//   platform-baseline-signin-legal [anonymous /login]:
//     FAIL — expect_visible [data-legal-footer] .legal-link:
//     locator.waitFor: Timeout 5000ms exceeded.
//
// The slot WAS on the page. The links inside it were not, because platform.js
// mounts them at runtime and the build's rewrite of login.html stopped that
// script running. Nothing in the report distinguished "the container is
// missing" from "the container is empty", and those have different fixes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  selectorPrefixes, diagnoseSelector, diagnosisDetail,
} from '../mock2/selector-diagnosis-logic.js';

/* ------------------------------- the split -------------------------------- */

test('a compound selector splits on descendant combinators', () => {
  assert.deepEqual(selectorPrefixes('[data-legal-footer] .legal-link'),
    ['[data-legal-footer]', '[data-legal-footer] .legal-link']);
  assert.deepEqual(selectorPrefixes('header .nav a.link'),
    ['header', 'header .nav', 'header .nav a.link']);
});

test('a simple selector has nothing to bisect', () => {
  // Reporting "the first part matched nothing" for a one-part selector is just
  // restating the failure with more words.
  for (const s of ['header', '#add-role', '.theme-toggle', '', null, '   ']) {
    assert.deepEqual(selectorPrefixes(s), [], JSON.stringify(s));
  }
});

test('SPACES INSIDE BRACKETS AND QUOTES ARE NOT COMBINATORS', () => {
  // split(' ') would cut `[data-x="a b"]` in half and then probe two selectors
  // that are both syntactically invalid — turning a diagnosis into a crash.
  assert.deepEqual(selectorPrefixes('[data-x="a b"]'), []);
  assert.deepEqual(selectorPrefixes("[title='one two'] .child"),
    ["[title='one two']", "[title='one two'] .child"]);
  assert.deepEqual(selectorPrefixes('div:not(.a .b) span'),
    ['div:not(.a .b)', 'div:not(.a .b) span']);
});

test('a child combinator stays attached to its part', () => {
  // `div >` is not a valid selector. Probing it would report "the invalid
  // prefix matched nothing", which is worse than saying nothing at all.
  assert.deepEqual(selectorPrefixes('div > span'), ['div', 'div > span']);
  assert.deepEqual(selectorPrefixes('ul>li .x'), ['ul>li', 'ul>li .x']);
  for (const p of selectorPrefixes('a > b + c ~ d e')) {
    assert.ok(!/[>+~]\s*$/.test(p), `prefix must not end in a combinator: ${p}`);
  }
});

/* ----------------------------- the diagnosis ------------------------------ */

test('THE PROJECT-47 CASE: the slot is there, the links are not', () => {
  const d = diagnoseSelector('[data-legal-footer] .legal-link', (p) => p === '[data-legal-footer]');
  assert.equal(d.containerPresent, true);
  assert.equal(d.deepest, '[data-legal-footer]');
  assert.match(d.cause, /platform\.js/, 'the contents come from a script — no amount of reading the markup reveals that');
  assert.match(d.cause, /login\.html is the usual cause/);

  const line = diagnosisDetail('[data-legal-footer] .legal-link', d);
  assert.match(line, /"\[data-legal-footer\]" IS present/);
  assert.match(line, /tree stops matching after it/);
});

test('the same selector, container ABSENT, gets a different cause', () => {
  // Different fix: one is "your script stopped running", the other is "you
  // deleted the slot". Reporting the same sentence for both would be the bug
  // this replaces, one layer up.
  const d = diagnoseSelector('[data-legal-footer] .legal-link', () => false);
  assert.equal(d.containerPresent, false);
  assert.match(d.cause, /no \[data-legal-footer\] slot at all/);
  assert.match(diagnosisDetail('[data-legal-footer] .legal-link', d), /not even the first part/);
});

test('a selector with no named cause still gets the bisection', () => {
  // The bisection is the mechanism; the named causes are a bonus. A table of
  // known baselines would have fixed one report and nothing else.
  const d = diagnoseSelector('#panel .row .cell', (p) => p === '#panel');
  assert.equal(d.deepest, '#panel');
  assert.equal(d.cause, '');
  assert.match(diagnosisDetail('#panel .row .cell', d), /"#panel" IS present/);
});

test('it reports the DEEPEST match, not the first', () => {
  const d = diagnoseSelector('a b c d', (p) => ['a', 'a b', 'a b c'].includes(p));
  assert.equal(d.deepest, 'a b c');
});

test('a simple selector produces no noise', () => {
  const d = diagnoseSelector('#add-role', () => false);
  assert.equal(diagnosisDetail('#add-role', d), '', 'nothing to bisect, nothing to say');
});

test('the theme control gets its menu hint', () => {
  const d = diagnoseSelector('header .theme-toggle', () => false);
  assert.match(d.cause, /menuOpener/, 'the fix is a declaration, not markup');
});

/* ------------------------------- the wiring ------------------------------- */

test('RATCHET: it runs on the FAILURE path only, and cannot mask the error', () => {
  const src = readFileSync(new URL('../mock2/ui-checks.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("case 'expect_visible'"), src.indexOf("case 'expect_enabled'"));
  assert.match(block, /await loc\.waitFor\(\{ state: 'visible'[\s\S]*?return \{ ok: true/,
    'a passing run must not probe anything');
  assert.match(block, /diagnosisDetail/);
  // The original Playwright message must survive: the diagnosis is additive.
  assert.match(block, /const base = String\(err\?\.message \|\| err\)/);
  assert.match(block, /extra \? `\$\{s\.selector\}: \$\{base\} — \$\{extra\}` : `\$\{s\.selector\}: \$\{base\}`/);
  // A diagnosis that throws must still yield the original failure.
  const inner = block.slice(block.indexOf('let extra'));
  assert.match(inner, /catch \{ \/\* the original error is still worth reporting \*\/ \}/);
});
