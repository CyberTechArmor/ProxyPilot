// PROMOTION — the approved design's growth path.
//
// state/design.css is generated from the mockup and everything downstream
// judges the app against it. That vocabulary is frozen at the moment the
// operator has seen the least, so a screen invented in build six had NO
// approved classes by construction: the build that thought of a better element
// measured worse than the build that traced, and nothing could change it.
//
// Native-free (risk R9): the promotion logic is pure; the container read/write
// is covered by the import check and the integration checklist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classRules, hardcodedColors, promotionCandidates, promoteInto, splitPromoted,
  splitPromotedEntries, promotionInviteMessage, PROMOTED_BEGIN, MAX_RULE_CHARS,
} from '../mock2/design-promote-logic.js';

const DESIGN = `:root{--app-bg:#fff;--surface-1:#fff;--text-1:#111}
.card { background: var(--surface-1); border-radius: 12px; }
.list-row { display: grid; }`;

test('a rule is found by every class it applies to, comments and all', () => {
  const rules = classRules(`
/* .decoy { color: red } — a comment, not a rule */
.a, .b > .c { color: var(--text-1); }
.d::after { content: "} not a brace"; }
@keyframes spin { to { transform: rotate(360deg) } }
@font-face { font-family: X; }
`);
  assert.deepEqual([...rules.keys()].sort(), ['a', 'b', 'c', 'd']);
  assert.ok(!rules.has('decoy'), 'a class named only inside a comment is not a rule');
  // A brace inside a string must not end the block — that is how a naive
  // scanner promotes half an element and leaves the stylesheet unparseable.
  assert.match(rules.get('d')[0], /content: "\} not a brace";/);
});

test('an element keeps its responsive rules when it moves', () => {
  // A component promoted without its @media rule looks right on a laptop and
  // overflows on a phone — in a codebase whose mobile rules are a merge gate,
  // that is not a detail.
  const rules = classRules(`
.tile { display: grid; grid-template-columns: repeat(3, 1fr); }
@media (max-width: 640px) {
  .tile { grid-template-columns: 1fr; }
  .other { display: none; }
}`);
  assert.equal(rules.get('tile').length, 2);
  assert.match(rules.get('tile')[1], /@media \(max-width: 640px\)/);
  assert.match(rules.get('tile')[1], /grid-template-columns: 1fr/);
  assert.doesNotMatch(rules.get('tile')[1], /\.other/, 'and not its neighbours');
});

test('what the build invented is what the approved design does not have', () => {
  const appCss = `
.card { background: var(--surface-1); }          /* already approved — not new */
.coverage-strip { display: flex; gap: var(--gap); background: var(--surface-1); }
.risk-chip { color: #b42318; background: #fee; }
`;
  const found = promotionCandidates({ designCss: DESIGN, appCss });
  assert.deepEqual(found.map((c) => c.name).sort(), ['coverage-strip', 'risk-chip']);
  const strip = found.find((c) => c.name === 'coverage-strip');
  const chip = found.find((c) => c.name === 'risk-chip');
  assert.equal(strip.tokenClean, true, 'built from the approved variables');
  assert.equal(chip.tokenClean, false, 'built beside them');
  assert.deepEqual(chip.hardcodedColors.sort(), ['#b42318', '#fee']);
  // The ones worth accepting are offered first.
  assert.equal(found[0].name, 'coverage-strip');
});

test('var() fallbacks are not hardcoded colours', () => {
  // The token bridge is BUILT from var(--x, #fallback); counting those would
  // mark every correctly-bridged element as drift and nothing would ever be
  // promotable.
  assert.deepEqual(hardcodedColors('.x{color:var(--text-1, #12263f);border:1px solid var(--line, rgb(1,2,3))}'), []);
  assert.deepEqual(hardcodedColors('.x{color:#abc}'), ['#abc']);
});

test('promoting an element makes it part of the approved design', () => {
  const el = { name: 'coverage-strip', css: '.coverage-strip { display: flex; gap: var(--gap); }' };
  const { css, promoted } = promoteInto(DESIGN, [el]);
  assert.deepEqual(promoted, ['coverage-strip']);
  assert.ok(css.includes(PROMOTED_BEGIN));
  // And it is now approved vocabulary by the same measure everything else uses.
  assert.ok(classRules(css).has('coverage-strip'), 'the adherence check counts it from here on');
  assert.ok(classRules(css).has('card'), 'without losing what the mockup approved');
});

test('promoting twice replaces, it does not accumulate', () => {
  // A promotion is a statement about what the element IS. Two copies is how a
  // stylesheet starts contradicting itself.
  const first = promoteInto(DESIGN, [{ name: 'tile', css: '.tile{padding:4px}' }]).css;
  const second = promoteInto(first, [{ name: 'tile', css: '.tile{padding:8px}' }]).css;
  assert.equal((second.match(/--- \.tile ---/g) || []).length, 1);
  assert.match(second, /padding:8px/);
  assert.doesNotMatch(second, /padding:4px/);
  assert.equal(splitPromotedEntries(splitPromoted(second).promoted).length, 1);
});

test('re-approving the design keeps what the operator accepted', () => {
  // The base half is regenerated from the mockup on every approval. If the
  // promoted block lived inside it, every re-approval would silently discard
  // the operator's decisions — and they would only find out from a gate.
  const withPromo = promoteInto(DESIGN, [{ name: 'tile', css: '.tile{padding:8px}' }]).css;
  const { base, promoted } = splitPromoted(withPromo);
  assert.ok(!base.includes('tile'), 'the base half is purely the mockup');
  assert.match(promoted, /\.tile\{padding:8px\}/);
  // Re-approval = a new base + the same promotions.
  const reapproved = promoteInto(`${base}\n.new-from-mockup{color:red}`, splitPromotedEntries(promoted));
  assert.ok(classRules(reapproved.css).has('tile'), 'the accepted element survives');
  assert.ok(classRules(reapproved.css).has('new-from-mockup'));
});

test('promotion refuses what would launder a second stylesheet into the design', () => {
  const huge = { name: 'everything', css: `.everything{${'padding:1px;'.repeat(MAX_RULE_CHARS)}}` };
  const dup = { name: 'card', css: '.card{background:#000}' };
  const junk = { name: '3v!l', css: '.x{}' };
  const { css, promoted, skipped } = promoteInto(DESIGN, [huge, dup, junk]);
  assert.deepEqual(promoted, []);
  assert.equal(skipped.length, 3);
  assert.match(skipped.find((s) => s.name === 'card').reason, /already defines it/);
  assert.match(skipped.find((s) => s.name === 'everything').reason, /an element, not a stylesheet/);
  assert.ok(!css.includes(PROMOTED_BEGIN), 'nothing accepted → no promoted block at all');
  // The design is otherwise untouched.
  assert.ok(classRules(css).has('card'));
});

test('the invitation is offered only for elements worth accepting', () => {
  const clean = [{ name: 'coverage-strip', tokenClean: true }, { name: 'risk-chip', tokenClean: false }];
  const msg = promotionInviteMessage(clean);
  assert.match(msg, /`\.coverage-strip`/);
  assert.doesNotMatch(msg, /risk-chip/, 'an element with the colours typed in is not invited');
  assert.match(msg, /Design → New elements/, 'and the operator is told where to do it');
  assert.equal(promotionInviteMessage([{ name: 'x', tokenClean: false }]), '', 'nothing to offer → silence');
  assert.equal(promotionInviteMessage([]), '');
});

test('promotion is reachable: routes, API client, and the panel exist', () => {
  // A pure layer nothing calls is a pure layer nobody uses. This is the exact
  // half-fix shape this codebase has shipped before.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const routes = readFileSync(path.join(here, '..', 'mock2', 'routes.js'), 'utf8');
  assert.match(routes, /design-elements/);
  assert.match(routes, /design-elements\/promote/);
  const client = readFileSync(path.join(here, '..', '..', '..', 'frontend', 'src', 'lib', 'api.js'), 'utf8');
  assert.match(client, /mock2PromoteDesignElements/);
  // body must be a STRING — the free-slot 400 came from exactly this line shape.
  assert.match(client, /design-elements\/promote`, \{ method: 'POST', body: JSON\.stringify\(/);
  const detail = readFileSync(path.join(here, '..', '..', '..', 'frontend', 'src', 'pages', 'ProjectDetail.jsx'), 'utf8');
  assert.match(detail, /<ProjectDesignElements/);
});
