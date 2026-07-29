// READING A REVIEW BACK INTO THE LIST OF DEFECTS IT ACTUALLY IS.
//
// The findings card and the Fix dialog both work off `parseFindings`, which
// reads a format `reviewChatMessage` in this repo generates. That is not
// scraping somebody else's output — it is reading our own — but it is still two
// files that have to agree, and the failure mode is silent: the label changes,
// the parse returns zero items, and the card quietly falls back to a wall of
// text with no ticks and no Fix button.
//
// So every case here runs the REAL generator and parses its REAL output. A
// fixture string typed by hand would keep passing after the format moved, which
// is exactly the bug it would be there to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewChatMessage } from '../mock2/design-review-logic.js';
import { parseFindings, composeFixInstruction, severityRank } from '../../../frontend/src/lib/findings.js';

const DESIGN = [
  {
    severity: 'high',
    screen: '/admin@390',
    issue: 'The Users table email column is far too narrow at mobile width, so addresses wrap character-by-character.',
    fix: 'Collapse the table to stacked cards below ~640px, or set the email cell to word-break:break-all.',
  },
  {
    severity: 'medium',
    screen: '/login@1280, /@390, /profile@390',
    issue: 'Footer links are washed-out light text on the near-white surface.',
    fix: 'Set footer link color to var(--accent) and add hover underline.',
  },
  { severity: 'low', screen: '/login@390', issue: 'Hero bullet drops the email channel.', fix: 'Restore the full copy.' },
];

const AXE = [
  { impact: 'critical', page: '/admin', help: 'Form elements must have labels', id: 'label' },
  { impact: 'serious', page: '/', help: 'Elements must meet minimum color contrast ratio thresholds', id: 'color-contrast' },
];

const ADHERENCE = {
  stats: { approved: 58, used: 10, ownTokens: 0, designClasses: 133, usedClasses: 53 },
  findings: [{ severity: 'medium', code: 'TOKENDRIFT', detail: 'The app uses 10/58 approved variables.' }],
};

const full = () => reviewChatMessage({
  review: { summary: 'Solid structural fidelity, but footer links are near-invisible.', findings: DESIGN },
  axe: AXE,
  adherence: ADHERENCE,
  screenshotCount: 6,
});

test('every finding in a real review message comes back as an item', () => {
  const p = parseFindings(full());
  assert.equal(p.items.length, DESIGN.length + AXE.length + ADHERENCE.findings.length);
  assert.match(p.headline, /^Design review \(/);
});

test('the three KINDS are told apart', () => {
  // They look nearly identical on the wire — same bullet, same [severity]. What
  // separates them is the fix clause, the trailing rule id, and a SHOUTED code
  // where a screen would be.
  const byKind = {};
  for (const f of parseFindings(full()).items) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  assert.deepEqual(byKind, { design: 3, accessibility: 2, adherence: 1 });
});

test('a design finding keeps its screens, its problem and its fix, separately', () => {
  const f = parseFindings(full()).items[0];
  assert.equal(f.severity, 'high');
  assert.equal(f.scope, '/admin@390');
  assert.match(f.issue, /email column is far too narrow/);
  assert.doesNotMatch(f.issue, /— fix:/, 'the fix must not be left glued to the problem');
  assert.match(f.fix, /Collapse the table/);
});

test('a multi-screen finding keeps all of its screens', () => {
  const f = parseFindings(full()).items[1];
  assert.equal(f.scope, '/login@1280, /@390, /profile@390');
});

test('an axe finding keeps its rule id out of the sentence', () => {
  const f = parseFindings(full()).items.find((x) => x.kind === 'accessibility');
  assert.equal(f.rule, 'label');
  assert.equal(f.issue, 'Form elements must have labels', 'the trailing "(label)" belongs in a field, not in the prose');
  assert.equal(f.fix, '', 'axe does not write fixes — the card must not pretend it did');
});

test('an adherence code is not mistaken for a screen', () => {
  const f = parseFindings(full()).items.find((x) => x.kind === 'adherence');
  assert.equal(f.scope, 'TOKENDRIFT');
});

test('the button prompt and the section headers are not findings', () => {
  // A checkbox next to "Press Fix these…" is a checkbox that wastes a decision.
  const p = parseFindings(full());
  for (const f of p.items) {
    assert.doesNotMatch(f.issue, /Press \*\*Fix/);
    assert.doesNotMatch(f.scope, /Accessibility/);
  }
  assert.ok(!p.extras.some((e) => /^Press \*\*Fix/.test(e)));
  assert.match(p.adherence, /^Design adherence:/);
});

test('the ALARMING form of the adherence line is recognised too', () => {
  // It reads "Design adherence:" normally and "**Visual drift** — …" when a
  // high-severity adherence finding fired. Matching only the calm one sent the
  // alarming one to the bottom of the card as loose text.
  const drifted = reviewChatMessage({
    review: { summary: 's', findings: [] },
    adherence: {
      stats: { approved: 58, used: 2, ownTokens: 40, designClasses: 133, usedClasses: 3 },
      findings: [{ severity: 'high', code: 'TOKENDRIFT', detail: 'the app has moved away from the design' }],
    },
    screenshotCount: 4,
  });
  const p = parseFindings(drifted);
  assert.match(p.adherence, /Visual drift/);
  assert.ok(!p.extras.some((e) => /Visual drift/.test(e)), 'it must lead the card, not trail it');
});

test('a clean review parses to no items rather than to nonsense', () => {
  const p = parseFindings(reviewChatMessage({
    review: { summary: 'No findings — the app matches its design well.', findings: [] },
    screenshotCount: 4,
  }));
  assert.deepEqual(p.items, []);
  assert.match(p.headline, /^Design review \(/);
});

test('garbage in does not throw', () => {
  for (const bad of ['', null, undefined, 'hello', '• broken', '[high] no bullet']) {
    const p = parseFindings(bad);
    assert.ok(Array.isArray(p.items));
  }
});

test('THE INSTRUCTION IS BUILT FROM WHAT SURVIVED THE TICKING', () => {
  // The whole reason the dialog exists. An operator who unticks four of seven
  // has said something; composing from the message would throw it away.
  const items = parseFindings(full()).items;
  const picked = [items[0], items[3]];
  const text = composeFixInstruction(picked, '');
  assert.match(text, /email column is far too narrow/);
  assert.doesNotMatch(text, /Footer links are washed-out/, 'an unticked finding must not reach the build');
  assert.match(text, /Fix these 2 design-review findings/);
});

test('the review\'s own fix wording is carried verbatim', () => {
  // It names variables and breakpoints. Rewording it into a summary is how a
  // precise instruction becomes a vague one.
  const items = parseFindings(full()).items;
  const text = composeFixInstruction([items[0]], '');
  assert.ok(text.includes(DESIGN[0].fix), 'the fix must survive intact');
  assert.match(text, /Fix this design-review finding/, 'and one finding reads as one, not as "1 findings"');
});

test('the operator\'s note is last, labelled, and WINS', () => {
  const items = parseFindings(full()).items;
  const text = composeFixInstruction(items.slice(0, 1), 'Only the admin table. Leave the footer alone.');
  assert.match(text, /Only the admin table/);
  assert.match(text, /this wins wherever it disagrees/,
    'a note that cannot override the findings is not worth typing');
  assert.ok(text.indexOf('Only the admin table') > text.indexOf(DESIGN[0].fix), 'the note comes after the list');
});

test('the instruction always fences the scope', () => {
  const items = parseFindings(full()).items;
  assert.match(composeFixInstruction(items, ''), /Change nothing else/);
  assert.equal(composeFixInstruction([], ''), '', 'nothing ticked and nothing typed is not a build');
  assert.match(composeFixInstruction([], 'just tighten the header'), /just tighten the header/,
    'a note alone is still an instruction');
});

test('severity ordering puts what matters first', () => {
  assert.ok(severityRank('critical') < severityRank('high'));
  assert.ok(severityRank('high') < severityRank('medium'));
  assert.ok(severityRank('medium') < severityRank('low'));
  assert.ok(severityRank('nonsense') > severityRank('low'), 'an unknown severity sorts last, not first');
});

test('groups compose short, referent-anchored requests — <=500 chars per group', async () => {
  const { groupFindings, composeGroupRequest, GROUP_CHAR_TARGET } = await import('../../../frontend/src/lib/findings.js');
  const long = (n) => Array.from({ length: 6 }, (_, i) => ({
    id: `f${n}-${i}`, scope: `/screen${n}`, severity: 'high', kind: 'design',
    issue: 'the stat tiles use 8px gaps where the cards above use 16px and the header wraps onto a second row at 390px'.repeat(2),
    fix: 'set the tile grid gap to var(--space-3), collapse the header actions into the overflow menu below 640px, and align the numeric column right'.repeat(2),
  }));
  const groups = groupFindings([...long(1), ...long(2)]);
  assert.equal(groups.length, 2, 'grouped by screen');
  for (const g of groups) {
    const req = composeGroupRequest(g);
    assert.ok(req.length <= GROUP_CHAR_TARGET, `group request must stay short, got ${req.length}`);
    assert.ok(req.startsWith(`On ${g.screen}:`), 'anchored on the screen referent');
  }
});

test('a short fix still rides verbatim inside its group', async () => {
  const { composeGroupRequest } = await import('../../../frontend/src/lib/findings.js');
  const req = composeGroupRequest({ screen: '/', findings: [{ issue: 'gap off', fix: 'use var(--space-2)' }] });
  assert.ok(req.includes('use var(--space-2)'));
});
