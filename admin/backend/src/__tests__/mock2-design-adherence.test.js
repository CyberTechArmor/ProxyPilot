// Design adherence — the four fixes for "the build ignored the approved design".
//
// The failure these cover, from a real build (project 36): the mockup carried
// ~35 CSS variables across three surface levels plus a full dark theme, the
// approved design.css handed to the build carried 20 flattened values and no
// dark theme, and the app that shipped referenced ZERO of them while declaring
// 32 of its own and hand-writing ~18KB of CSS. Every gate passed. The design
// review posted nothing. Nobody could see any of it in the downloaded log,
// because every tool result stopped at 8,000 chars.
//
// Native-free (risk R9): the pure layers only — no container, no DB, no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  extractMockupStyles, splitMockupCss, renderDesignCssFromMockup,
} from '../mock2/concept-logic.js';
import {
  definedCssVars, usedCssVars, checkDesignAdherence,
  reviewChatMessage, composePolishInstruction,
} from '../mock2/design-review-logic.js';
import {
  DESIGN_ADHERENCE_GATE_NAME, DESIGN_ADHERENCE_GATE_SCRIPT,
} from '../mock2/baseline-gates.js';
import {
  withBaselineGates, buildGateBattery, BUILD_MODE_FULL, BUILD_MODE_QUICK, BUILD_MODE_MVP,
} from '../mock2/cycle-logic.js';
import { eventContentBudget, clipEventContent, EVENT_CONTENT_BUDGETS } from '../mock2/cycle-events-logic.js';

// A mockup shaped like the one that shipped a lackluster build: a fenced token
// block with three surface levels + a dark theme, then real component CSS.
const TOKENS_BLOCK = `/* ==tokens== */
:root{
  --surface:#fff; --surface-2:#f6f7f9; --surface-3:#eceef2;
  --text:#0b1220; --text-2:#4b5563; --text-3:#8b94a3;
  --hairline:#e4e7ec; --accent:#0d9488; --accent-tint:#e6fffb; --warn:#b45309;
  --stage-mvp-bg:#eef6ff; --stage-full-bg:#f3f0ff;
  --stage-mvp-fg:#1d4ed8; --stage-full-fg:#6d28d9; --stage-idea-bg:#fff7ed; --stage-idea-fg:#b45309;
  --font-sans:Inter,system-ui,sans-serif; --font-mono:ui-monospace,monospace;
  --radius-sm:6px; --radius:10px; --radius-lg:16px; --radius-pill:999px;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-6:24px;
  --shadow-1:0 1px 2px rgba(0,0,0,.06); --shadow-2:0 8px 24px rgba(0,0,0,.10);
}
[data-theme="dark"]{
  --surface:#0b1220; --surface-2:#111a2b; --surface-3:#18233a;
  --text:#e8edf5; --text-2:#a3adbe; --text-3:#6b7686;
  --hairline:#1e2a40; --accent:#2dd4bf; --accent-tint:#062e2b; --warn:#f59e0b;
  --stage-mvp-bg:#0d2035; --stage-full-bg:#1a1330;
}
/* ==/tokens== */`;

const COMPONENT_CSS = `
.rail{background:var(--surface-2);border-right:1px solid var(--hairline)}
.note-card{background:var(--surface);color:var(--text)}
@media (max-width: 768px){ .rail{display:none} }
`;

const MOCKUP = `<!doctype html><html><head><style>${TOKENS_BLOCK}\n${COMPONENT_CSS}</style></head><body></body></html>`;

// ---- fix 1: carry the mockup's real design into design.css ----

test('extractMockupStyles + splitMockupCss separate the fenced tokens from the components', () => {
  const css = extractMockupStyles(MOCKUP);
  assert.ok(css.includes('--surface-3'), 'style block extracted');
  const { tokens, components } = splitMockupCss(css);
  assert.ok(tokens.includes('--stage-mvp-bg'), 'tokens carry the stage colors');
  assert.ok(tokens.includes('[data-theme="dark"]'), 'tokens carry the dark theme');
  assert.ok(!components.includes('--surface-3:'), 'the fence is removed from the component half');
  assert.ok(components.includes('.note-card'), 'components survive');
});

test('renderDesignCssFromMockup carries the WHOLE approved design, dark theme included', () => {
  const d = renderDesignCssFromMockup(MOCKUP);
  assert.equal(d.source, 'mockup');
  assert.equal(d.hasDark, true, 'the dark theme is carried — the shipped theme toggle depends on it');
  // The old path rendered a fixed 20-value schema; the point of this fix is
  // that a richer design is no longer flattened down to it.
  assert.ok(d.tokenCount >= 24, `carries the mockup's own token count, got ${d.tokenCount}`);
  for (const v of ['--surface-2', '--surface-3', '--text-2', '--hairline', '--stage-mvp-bg']) {
    assert.ok(d.css.includes(v), `carries ${v}`);
  }
  assert.ok(d.css.includes('.note-card'), 'carries the component CSS');
  assert.ok(d.css.includes('@media'), 'carries the responsive rules');
});

test('renderDesignCssFromMockup falls back to the token schema when there is no fence', () => {
  const d = renderDesignCssFromMockup('<html><head><style>.x{color:red}</style></head></html>');
  assert.equal(d.source, 'tokens');
  assert.ok(d.css.length > 0, 'a project without a fenced mockup still gets a design.css');
});

// ---- fix 2: the adherence check + the gate ----

test('definedCssVars / usedCssVars tell declaration apart from consumption', () => {
  const defined = definedCssVars(':root{--a:1;--b:2}.x{color:var(--c)}');
  assert.deepEqual([...defined].sort(), ['--a', '--b']);
  const used = usedCssVars('.x{color:var(--c);background:var( --d )}');
  assert.deepEqual([...used].sort(), ['--c', '--d']);
});

test('checkDesignAdherence flags the project-36 shape: zero approved vars used, own palette, dark dropped', () => {
  const designCss = renderDesignCssFromMockup(MOCKUP).css;
  const appCss = `:root{${Array.from({ length: 32 }, (_, i) => `--own-${i}:#000`).join(';')}}\n`
    + Array.from({ length: 200 }, (_, i) => `.c${i}{color:var(--own-1)}`).join('\n');
  const r = checkDesignAdherence({ designCss, appCss });
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes('DESIGN_TOKENS_UNUSED'), 'names the ignored design');
  assert.ok(codes.includes('PARALLEL_TOKEN_SYSTEM'), 'names the second palette');
  assert.ok(codes.includes('DARK_THEME_DROPPED'), 'names the toggle that now does nothing');
  assert.equal(r.ok, false);
});

test('checkDesignAdherence passes an app built ON the approved design, and skips when nothing is approved', () => {
  const designCss = renderDesignCssFromMockup(MOCKUP).css;
  const appCss = '.a{color:var(--text);background:var(--surface-2);border-color:var(--hairline)}'
    + '.b{background:var(--surface-3);color:var(--text-2)}'
    + '.c{color:var(--accent);background:var(--accent-tint)}'
    + '.d{color:var(--warn);background:var(--stage-mvp-bg)}'
    + '.e{background:var(--stage-full-bg);color:var(--text-3)}'
    + '.f{background:var(--surface)}[data-theme="dark"] .a{opacity:.9}';
  assert.equal(checkDesignAdherence({ designCss, appCss }).ok, true);
  // No approved design (an older project) is not a defect.
  const none = checkDesignAdherence({ designCss: '', appCss });
  assert.equal(none.ok, true);
  assert.equal(none.findings.length, 0);
});

test('adherence findings reach the operator: the chat message and the polish instruction', () => {
  const adherence = checkDesignAdherence({
    designCss: renderDesignCssFromMockup(MOCKUP).css,
    appCss: `:root{${Array.from({ length: 32 }, (_, i) => `--own-${i}:#000`).join(';')}}.c{color:var(--own-1)}`,
  });
  const msg = reviewChatMessage({ review: { summary: 's', findings: [] }, adherence, trigger: 'auto', screenshotCount: 4 });
  // Drift is the HEADLINE, not a footnote under the accessibility list: it is
  // the question this review exists to answer, and an app that had drifted
  // badly used to be able to read as clean.
  assert.match(msg, /\*\*Visual drift\*\*/);
  const lines = msg.split('\n');
  assert.match(lines[1], /Visual drift/, 'drift must be the second line, right under the summary');
  assert.match(msg, /approved design variable/);
  assert.match(msg, /DESIGN_TOKENS_UNUSED/);
  const instr = composePolishInstruction({ review: { findings: [] }, adherence });
  assert.ok(instr, 'adherence alone is enough to compose a polish pass');
  assert.match(instr, /design system:/);
});

test('withBaselineGates rides every battery, never stacks, and yields to an operator gate of the same name', () => {
  const framework = [{ name: 'tsc', script: 'npx tsc', order: 0 }];
  const withBase = withBaselineGates(framework, 'full');
  assert.ok(withBase.map((g) => g.name).includes(DESIGN_ADHERENCE_GATE_NAME));
  assert.deepEqual(
    withBaselineGates(withBase, 'full').map((g) => g.name), withBase.map((g) => g.name), 'idempotent',
  );
  // An operator who wrote their own stricter version keeps theirs.
  const own = [{ name: DESIGN_ADHERENCE_GATE_NAME, script: 'my-own-check', order: 0 }];
  const merged = withBaselineGates(own, 'full');
  assert.equal(merged.find((g) => g.name === DESIGN_ADHERENCE_GATE_NAME).script, 'my-own-check');
  assert.equal(merged.filter((g) => g.name === DESIGN_ADHERENCE_GATE_NAME).length, 1);
});

test('every build mode now runs SOME gates — the zero-gate default path is gone', () => {
  const framework = [
    { name: 'tsc', script: '#', order: 0 },
    { name: 'security-scan', script: '#', order: 1 },
    { name: 'slow-custom-thing', script: '#', order: 2 },
  ];
  const byMode = {};
  for (const mode of [BUILD_MODE_QUICK, BUILD_MODE_MVP, BUILD_MODE_FULL]) {
    const b = buildGateBattery(framework, mode);
    byMode[mode] = b;
    assert.ok(b.gates.length > 0, `${mode} runs at least one gate`);
    assert.ok(b.gates.some((g) => g.name === 'platform-intact'), `${mode} protects the base app`);
  }
  // design-adherence is ADVISORY on quick so an app's pre-existing design debt
  // cannot wedge a one-line edit, and BLOCKING from the MVP build up.
  const adh = (m) => byMode[m].gates.find((g) => g.name === DESIGN_ADHERENCE_GATE_NAME);
  assert.equal(adh(BUILD_MODE_QUICK).advisory, true);
  assert.equal(adh(BUILD_MODE_MVP).advisory, false);
  assert.equal(adh(BUILD_MODE_FULL).advisory, false);
  // An UNTAGGED operator gate is full-only: a four-minute custom check must
  // never land in the MVP lane because someone forgot a field.
  const names = (m) => byMode[m].gates.map((g) => g.name);
  assert.ok(!names(BUILD_MODE_MVP).includes('slow-custom-thing'));
  assert.ok(names(BUILD_MODE_FULL).includes('slow-custom-thing'));
  // The visual gates are the MVP's whole point.
  assert.ok(names(BUILD_MODE_MVP).includes('mobile-overflow'));
  assert.ok(names(BUILD_MODE_MVP).includes('no-dead-controls'));
  assert.ok(!names(BUILD_MODE_QUICK).includes('mobile-overflow'));
});

test('an advisory gate reports its failure but exits 0', () => {
  const b = buildGateBattery([], BUILD_MODE_QUICK);
  const adh = b.gates.find((g) => g.name === DESIGN_ADHERENCE_GATE_NAME);
  assert.match(adh.script, /ADVISORY placement/);
  assert.match(adh.script, /exit 0\n$/);
});

// The gate is a shell script that runs in the container; run it for real.
function runGate(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pp-gate-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    }
    const script = path.join(dir, 'gate.sh');
    writeFileSync(script, DESIGN_ADHERENCE_GATE_SCRIPT);
    try {
      const out = execFileSync('sh', [script], { cwd: dir, encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A design.css must ALSO drive the app shell's --app-* family, or the header,
// nav, buttons, theme toggle, legal footer and sign-in page ignore the approved
// design. Every real design.css does — the preset path declares them directly,
// the mockup path through the generated bridge — so the fixture does too.
const SHELL_VARS = '--app-bg:#101;--app-text:#102;--app-surface:#103;--app-primary:#104;';
const GATE_DESIGN = ':root{' + SHELL_VARS
  + Array.from({ length: 20 }, (_, i) => `--app-t${i}:#10${i}`).join(';')
  + '}[data-theme="dark"]{'
  + Array.from({ length: 20 }, (_, i) => `--app-t${i}:#90${i}`).join(';')
  + '}';

test('GATE: fails the build that re-invented the design system', () => {
  const appCss = `:root{${Array.from({ length: 32 }, (_, i) => `--own-${i}:#ab${i}`).join(';')}}\n`
    + Array.from({ length: 400 }, (_, i) => `.c${i}{color:var(--own-1);padding:8px}`).join('\n');
  const r = runGate({ 'state/design.css': GATE_DESIGN, 'public/app.css': appCss });
  assert.equal(r.code, 1, 'red');
  assert.match(r.out, /reference NONE of the \d+ approved design variables/);
  assert.match(r.out, /theme toggle changes nothing/);
});

test('GATE: fails a parallel palette even when a few approved vars are used', () => {
  const appCss = `:root{${Array.from({ length: 15 }, (_, i) => `--mine-${i}:#cd${i}`).join(';')}}\n`
    + Array.from({ length: 300 }, (_, i) => `.c${i}{color:var(--mine-1)}`).join('\n')
    + '\n.a{color:var(--app-t1)}.b{color:var(--app-t2)}.c{color:var(--app-t3)}\n'
    + '[data-theme="dark"] .a{opacity:.9}';
  const r = runGate({ 'state/design.css': GATE_DESIGN, 'public/app.css': appCss });
  assert.equal(r.code, 1);
  assert.match(r.out, /declares 15 design variables of its own/);
});

test('GATE: passes an app built on the approved design', () => {
  const appCss = Array.from({ length: 400 }, (_, i) => `.c${i}{color:var(--app-t${i % 20});background:var(--app-t3)}`).join('\n')
    + '\n[data-theme="dark"] .c1{opacity:.9}';
  const r = runGate({ 'state/design.css': GATE_DESIGN, 'public/app.css': appCss });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /builds on the approved design/);
});

test('GATE: never blocks what it cannot judge — no design, no app CSS, or a thin preset', () => {
  const bulk = Array.from({ length: 400 }, (_, i) => `.c${i}{color:#333;padding:8px}`).join('\n');
  // Nothing approved.
  assert.equal(runGate({ 'public/app.css': bulk }).code, 0);
  // A fresh scaffold: design.css exists, the build has written no CSS of its
  // own, and the scaffold's own copies are excluded from the app side.
  const fresh = runGate({ 'state/design.css': GATE_DESIGN, 'public/design.css': GATE_DESIGN, 'public/base.css': ':root{--x:1}' });
  assert.equal(fresh.code, 0, fresh.out);
  assert.match(fresh.out, /has not written screens or CSS/);
  // A preset-only project has too thin a system to enforce.
  const thin = runGate({ 'state/design.css': `:root{${SHELL_VARS}}`, 'public/app.css': bulk });
  assert.equal(thin.code, 0);
  assert.match(thin.out, /fewer than 8 approved variables/);
});

// ---- fix 4: the downloaded build log stops clipping the evidence ----

test('cycle-event budgets: a tool result keeps enough to be evidence, and truncation keeps the tail', () => {
  assert.ok(EVENT_CONTENT_BUDGETS.tool_result >= 64_000, 'a tool result is the evidence');
  assert.ok(eventContentBudget('tool_result') > eventContentBudget('unknown_kind'), 'kind-aware');
  const body = `${'H'.repeat(200_000)}ERROR: the actual failure`;
  const clipped = clipEventContent(body, 'tool_result');
  assert.ok(clipped.length < body.length, 'still bounded');
  assert.ok(clipped.startsWith('HHHH'), 'the head survives');
  assert.ok(clipped.endsWith('ERROR: the actual failure'), 'the TAIL survives — that is where the error is');
  assert.match(clipped, /truncated \d+ chars/, 'says what went missing');
  // Under budget is returned untouched.
  assert.equal(clipEventContent('short', 'tool_result'), 'short');
});

test('cycle-event budgets: MOCK2_MAX_EVENT_CHARS overrides but cannot exceed the ceiling', () => {
  const prev = process.env.MOCK2_MAX_EVENT_CHARS;
  try {
    process.env.MOCK2_MAX_EVENT_CHARS = '1000';
    assert.equal(eventContentBudget('tool_result'), 1000);
    process.env.MOCK2_MAX_EVENT_CHARS = '99999999';
    assert.equal(eventContentBudget('tool_result'), 64_000);
  } finally {
    if (prev === undefined) delete process.env.MOCK2_MAX_EVENT_CHARS;
    else process.env.MOCK2_MAX_EVENT_CHARS = prev;
  }
});

test('a clean app reports adherence without crying drift', () => {
  const designCss = renderDesignCssFromMockup(MOCKUP).css;
  const vars = [...designCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]);
  const appCss = vars.map((v, i) => `.a${i}{color:var(${v})}`).join('\n');
  const adherence = checkDesignAdherence({ designCss, appCss });
  const msg = reviewChatMessage({ review: { summary: 'looks right', findings: [] }, adherence, trigger: 'auto', screenshotCount: 4 });
  assert.doesNotMatch(msg, /Visual drift/);
  assert.match(msg, /Design adherence:/);
});

test('the review sees the MARKUP, not only the stylesheets (project 39)', () => {
  // 328 lines of HTML and no CSS measured as "nothing to judge" in the review
  // exactly as it did in the gate. Screens with no styling and none of the
  // approved components is a HIGH finding, not silence.
  const designCss = renderDesignCssFromMockup(MOCKUP).css;
  const appHtml = `<html><body>${Array.from({ length: 120 }, (_, i) => `<div class="row"><span>Field ${i}</span><button>Go</button></div>`).join('')}</body></html>`;
  const adherence = checkDesignAdherence({ designCss, appCss: '', appHtml });
  assert.equal(adherence.ok, false, 'unstyled screens must not pass');
  assert.ok(adherence.findings.some((f) => f.code === 'SCREENS_UNSTYLED' || f.code === 'COMPONENTS_UNUSED'),
    `expected a structural finding, got: ${adherence.findings.map((f) => f.code).join(', ')}`);
  assert.ok(adherence.stats.designClasses >= 0);
});

test('markup that speaks the approved component vocabulary is not flagged', () => {
  const designCss = `${renderDesignCssFromMockup(MOCKUP).css}\n.mk-card{color:red}\n.mk-list{color:red}\n.mk-bar{color:red}\n.mk-chip{color:red}\n.mk-fab{color:red}\n.mk-empty{color:red}\n`;
  const appHtml = `<html><body><div class="mk-bar"></div><ul class="mk-list">${
    Array.from({ length: 60 }, (_, i) => `<li class="mk-card"><span class="mk-chip">${i}</span></li>`).join('')
  }</ul><div class="mk-empty"></div><button class="mk-fab">+</button></body></html>`;
  const adherence = checkDesignAdherence({ designCss, appCss: '', appHtml });
  assert.ok(!adherence.findings.some((f) => f.code === 'SCREENS_UNSTYLED' || f.code === 'COMPONENTS_UNUSED'),
    `should not flag faithful markup: ${adherence.findings.map((f) => f.code).join(', ')}`);
});

/* ------------------- the trigger, which is what was broken ------------------ */
//
// Project 39's build DEPLOYED, ended in pending_verification, and was never
// reviewed — because the whole post-build chain hung off a REQUEST closing as
// 'succeeded', and a pending-verification build never closes its request. The
// smoke-spec backstop routes MORE builds down that path by design, so the
// trigger had to move rather than the symptom being patched.
//
// Source-level assertions: the wiring is native (containers, browsers, model
// calls) and cannot be imported in the sandbox, but WHERE it is called from is
// exactly the thing that regressed and it is plainly readable.

test('the post-build review chain lives in one place', async () => {
  const src = await readFile(new URL('../mock2/design-review.js', import.meta.url), 'utf8');
  assert.match(src, /export async function afterBuildReview/);
  // All three steps, in order: serving, an account to look with, the critique.
  const i = src.indexOf('export async function afterBuildReview');
  const body = src.slice(i, i + 3000);
  assert.ok(body.indexOf('ensureServing') < body.indexOf('ensureReviewAccount'), 'serving check must come first');
  assert.ok(body.indexOf('ensureReviewAccount') < body.indexOf('maybeAutoDesignReview'), 'the account must exist before the capture');
  // The queue guard lives here, so both callers behave identically.
  assert.match(body, /listBuildQueue/);
});

test('every terminal path that deployed fires the review', async () => {
  const runner = await readFile(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  const screenPlan = await readFile(new URL('../mock2/screen-plan.js', import.meta.url), 'utf8');

  // 1. A request closing as succeeded (the path that always worked).
  assert.match(screenPlan, /afterBuildReview\(pid/);

  // 2. EVERY pending-verification terminal — there are more than one, and the
  //    second (the operator's accept-as-pending flow) deploys as well. Checking
  //    only the first is how one of them stayed unreviewed.
  const terminals = [...runner.matchAll(/outcome: 'pending_verification'/g)].map((m) => m.index);
  assert.ok(terminals.length >= 2, `expected several pending-verification terminals, found ${terminals.length}`);
  terminals.forEach((at, i) => {
    const after = runner.slice(at, at + 1200);
    assert.match(after, /afterBuildReview/,
      `pending-verification terminal #${i + 1} deployed and must still be reviewed`);
  });
});
