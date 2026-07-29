// Design-review pure layer (design-review-logic.js): the critique prompt
// contract, the tolerant reply parse, the rogue-color lint (advisory, never a
// gate), and the chat/polish-instruction composition. Native-free (risk R9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReviewPrompt, parseReviewReply, tokenColorSet, rogueCssColors,
  reviewChatMessage, composePolishInstruction,
} from '../mock2/design-review-logic.js';

test('review prompt: strict JSON contract with the design-lead lenses', () => {
  const p = buildReviewPrompt();
  assert.match(p, /STRICT JSON only/);
  for (const lens of ['FIDELITY', 'CRAFT', 'STATES', 'MOBILE']) assert.ok(p.includes(lens), `names ${lens}`);
  assert.match(p, /"severity": "high" \| "medium" \| "low"/);
});

test('parseReviewReply: valid, fenced, junk; severities validated; strings clamped', () => {
  const good = parseReviewReply('{"summary":"solid","findings":[{"screen":"/","severity":"high","issue":"stat tiles use 8px gaps","fix":"use 16px"}]}');
  assert.equal(good.summary, 'solid');
  assert.equal(good.findings[0].severity, 'high');
  const fenced = parseReviewReply('```json\n{"summary":"ok","findings":[]}\n```');
  assert.deepEqual(fenced.findings, []);
  assert.equal(parseReviewReply('looks good to me!'), null);
  assert.equal(parseReviewReply(''), null);
  // Bad severity coerces to medium; finding without an issue is dropped.
  const odd = parseReviewReply('{"findings":[{"screen":"/x","severity":"fatal","issue":"a"},{"screen":"/y","severity":"low"}]}');
  assert.equal(odd.findings.length, 1);
  assert.equal(odd.findings[0].severity, 'medium');
});

test('rogue-color lint: token + neutral + var() colors pass; drift is counted', () => {
  const tokens = JSON.stringify({ colors: { primary: '#1466b8', accent: 'rgb(18, 163, 163)' } });
  assert.ok(tokenColorSet(tokens).has('#1466b8'));
  const css = `
    .a { color: #1466B8; }                 /* token (case-insensitive) */
    .b { color: var(--app-x, #999999); }   /* var() fallback — the token mechanism */
    .c { background: #fff; border: 1px solid #666; }  /* white is neutral; the grey is rogue */
    .d { color: #666666; }                 /* same rogue again, longhand */
    .e { outline: rgb(18,163,163); }       /* token rgb, whitespace-insensitive */
  `;
  const rogue = rogueCssColors(css, tokens);
  assert.equal(rogue.length, 1);
  assert.equal(rogue[0].color, '#666666');
  assert.equal(rogue[0].count, 2);
  // No tokens file → everything non-neutral reports (still advisory).
  assert.ok(rogueCssColors('.x{color:#123456}', '').length === 1);
});

test('chat message + polish instruction compose from findings, axe, and drift', () => {
  const review = { summary: 'close to the mockup', findings: [{ screen: '/', severity: 'high', issue: 'no bottom tab bar', fix: 'add it per the mockup' }] };
  const axe = [{ page: '/', id: 'color-contrast', impact: 'serious', help: 'Elements must meet contrast' }, { page: '/', id: 'region', impact: 'moderate', help: 'landmarks' }];
  const rogue = [{ color: '#666666', count: 2 }];
  const msg = reviewChatMessage({ review, axe, rogue, trigger: 'auto', screenshotCount: 4 });
  assert.match(msg, /Design review \(after build\)/);
  assert.match(msg, /\[high\] \/: no bottom tab bar/);
  assert.match(msg, /1 serious\/critical/); // moderate axe finding filtered out
  assert.match(msg, /Token drift/);
  const instr = composePolishInstruction({ review, axe, rogue });
  assert.match(instr, /no new features/);
  assert.match(instr, /1\. \/: no bottom tab bar/);
  assert.match(instr, /color-contrast/);
  assert.match(instr, /var\(--app-\*\)/);
  // Nothing to fix → no instruction (the polish build is skipped).
  assert.equal(composePolishInstruction({ review: { findings: [] }, axe: [], rogue: [] }), null);
});

test('feedback distillation + inventory journeys ride the pure layers', async () => {
  const { buildFeedbackSection } = await import('../mock2/runner-logic.js');
  const s = buildFeedbackSection(['cramped mobile spacing', 'cramped mobile spacing', '  ']);
  assert.match(s, /Recurring operator feedback/);
  assert.match(s, /- cramped mobile spacing/);
  assert.equal(buildFeedbackSection([]), '');
  assert.equal(buildFeedbackSection(null), '');

  const { parseInventory, mockupRenderModel, MOCKUP_PREFERRED_MODEL } = await import('../mock2/concept-logic.js');
  const inv = parseInventory(JSON.stringify({
    screens: [{ name: 'Home', purpose: 'p' }],
    journeys: [
      { name: 'clock in', steps: ['open home', 'tap clock in'], frequency: 'daily' },
      { name: 'weird', frequency: 'sometimes' },
    ],
  }));
  assert.equal(inv.ok, true);
  assert.equal(inv.inventory.journeys.length, 2);
  assert.equal(inv.inventory.journeys[0].frequency, 'daily');
  assert.equal(inv.inventory.journeys[1].frequency, 'occasional'); // unknown → occasional
  // Older extractions without journeys stay valid.
  assert.deepEqual(parseInventory('{"screens":[{"name":"A"}]}').inventory.journeys, []);

  // Mockup render model: preferred by default, env override, 'slot' restores.
  assert.equal(mockupRenderModel({}, 'claude-haiku-4-5'), MOCKUP_PREFERRED_MODEL);
  assert.equal(mockupRenderModel({ MOCK2_MOCKUP_MODEL: 'claude-opus-4-8' }, 'x'), 'claude-opus-4-8');
  assert.equal(mockupRenderModel({ MOCK2_MOCKUP_MODEL: 'slot' }, 'claude-haiku-4-5'), 'claude-haiku-4-5');
});

/* ================== SCREENS ARE NOT ROUTES (project 47) ================== */
//
// "Please tell me why the screen capture seems capped at 6 screens and not all
// seemed filled out/tested."
//
// MAX_PATHS = 4 routes × (mobile + desktop on the first two) = 6 shots. The
// paths were `/`, `/login`, and whatever pages the ui-checks spec named — for
// the notes app, `/admin` and `/profile`. But the app is an SPA built to the
// mockup's own convention (`section[data-screen]`, one `.screen-active`), so
// the note DETAIL and the note EDITOR both live at `/`. The two screens the
// operator was unhappy with had never been photographed by any review, on any
// build — while the reviewer spent two of its four slots on the platform's own
// admin and profile pages.

test('RATCHET: the review reaches screens inside a route, not just routes', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mock2/design-review.js', import.meta.url), 'utf8');
  assert.match(src, /section\[data-screen\]/,
    "the mockup's own screen convention must be what the reviewer looks for");
  assert.match(src, /MAX_SCREEN_PANELS/);
  // Only the panels that are NOT already showing — the active one is the shot
  // that was just taken, and re-shooting it would spend a slot on a duplicate.
  assert.match(src, /!el\.classList\.contains\('screen-active'\)/);
  // Labelled so a finding cites something the operator can navigate to.
  assert.match(src, /\$\{path\}#\$\{name\}/);
});

test('RATCHET: it puts the route back, and can never fail the capture', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mock2/design-review.js', import.meta.url), 'utf8');
  const i = src.indexOf('The screens INSIDE this route');
  assert.ok(i > 0);
  const block = src.slice(i, src.indexOf('if (axeSource) {', i));
  assert.match(block, /classList\.toggle\('screen-active', i === 0\)/,
    'the desktop shot below must be of the same screen as the mobile one above');
  assert.match(block, /catch \{ \/\* a screen that will not activate is not worth failing over \*\/ \}/,
    'the review is never a gate — a stubborn panel must not cost the critique around it');
});
