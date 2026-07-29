// THE BUILD CONTRACT (harness redesign, Phase 2) — the prompts and the checks
// must tell the same story. P47's builds printed contract strings on buttons,
// promoted every action to the top level, badged everything unfinished, and
// rephrased rejected finish prose five times; the checks were fixed in this
// branch and these tests pin that the PROMPTS now agree with them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_CONTRACT_SECTION, buildRunnerSystemPrompt, buildRunnerClaudeMd,
} from '../mock2/runner-logic.js';
import { formatSpecificityForTask } from '../mock2/prepass-logic.js';

test('the contract section rides BOTH prompt builders verbatim (no drift)', () => {
  const sys = buildRunnerSystemPrompt({ constitution: 'C', buildMode: 'full' });
  const md = buildRunnerClaudeMd({ constitution: 'C' });
  assert.ok(sys.includes(BUILD_CONTRACT_SECTION), 'system prompt carries it');
  assert.ok(md.includes(BUILD_CONTRACT_SECTION), 'CLAUDE.md carries it');
});

test('capability placement: actions are capabilities, never all top-level', () => {
  assert.match(BUILD_CONTRACT_SECTION, /CAPABILITIES a\nuser must be able to perform, not button captions/);
  assert.match(BUILD_CONTRACT_SECTION, /overflow menu, a detail view, a\nsettings screen — not all on the top level/);
  assert.match(BUILD_CONTRACT_SECTION, /never requires a top-level control/);
});

test('restraint: the design wins over a pushing check; explicit user departures win over the design', () => {
  assert.match(BUILD_CONTRACT_SECTION, /THE DESIGN WINS pending an operator\ndecision/);
  assert.match(BUILD_CONTRACT_SECTION, /EXPLICIT\nuser instruction to depart from them wins/);
  assert.match(BUILD_CONTRACT_SECTION, /project deviation/);
});

test('honest deferral: the badge is conditional on the mockup showing the control', () => {
  assert.match(BUILD_CONTRACT_SECTION, /if the approved mockup SHOWS its\ncontrol/);
  assert.match(BUILD_CONTRACT_SECTION, /leave it out and say so in your finish summary/);
  assert.ok(!/must be VISIBLY marked in the UI/.test(BUILD_CONTRACT_SECTION),
    'the unconditional badge-everything instruction must be gone');
});

test('rejection handling: fix the structure, not the prose; halt with the payload verbatim', () => {
  assert.match(BUILD_CONTRACT_SECTION, /do NOT keep rephrasing/);
  assert.match(BUILD_CONTRACT_SECTION, /echoes the parameter names and values the harness actually received/);
  assert.match(BUILD_CONTRACT_SECTION, /quote the payload and the rejection verbatim/);
});

test('the specificity classification reaches the build task', () => {
  const vague = formatSpecificityForTask({ specificity: 'vague', scope: 'feature_scale' });
  assert.match(vague, /classified VAGUE \(scope: feature_scale\)/);
  assert.match(vague, /domain expert/);
  assert.match(vague, /state in 3-6 lines/);
  assert.match(vague, /do not gold-plate/);

  const clear = formatSpecificityForTask({ specificity: 'clear', scope: 'simple' });
  assert.match(clear, /classified SPECIFIC/);
  assert.match(clear, /never modify the UI to satisfy what you guess a checker matches on/);
  assert.match(clear, /state the conflict in your finish summary/);

  assert.equal(formatSpecificityForTask(null), '', 'no pre-pass, no directive');
});

test('the MVP seed carries the numbered contract and the conditional badge', async () => {
  const src = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../mock2/concept.js', import.meta.url), 'utf8'));
  const i = src.indexOf('const INITIAL_BUILD_INSTRUCTION');
  const seed = src.slice(i, i + 3500);
  assert.match(seed, /already in this container/);
  assert.match(seed, /never rebuild, shadow, or duplicate/);
  assert.match(seed, /CAPABILITIES users must be able to perform/);
  assert.match(seed, /Restraint is part of the contract/);
  assert.match(seed, /only if the mockup shows its control/);
});

test('the quick-update seed says specific-means-literal', () => {
  const sys = buildRunnerSystemPrompt({ constitution: 'C', buildMode: 'quick' });
  assert.match(sys, /SPECIFIC MEANS LITERAL/);
  assert.match(sys, /satisfy the instruction and state the conflict/);
});

test('the mockup prompt distinguishes thin briefs from specific ones', async () => {
  const { buildMockupSystemPrompt } = await import('../mock2/concept-logic.js');
  const p = buildMockupSystemPrompt({});
  assert.match(p, /Vague brief vs specific brief/);
  assert.match(p, /DOMAIN EXPERT/);
  assert.match(p, /do not gold-plate/);
  assert.match(p, /follow it literally and completely/);
});
