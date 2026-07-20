// Mockup acceptance checks (part 3): the battery passes the conforming Spec
// Ops Hub fixture and catches each observed defect class when seeded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runMockupChecks, mockupChecksNote, contrastRatio,
  checkLegacyPalette, checkRogueHexes, checkThemes, checkBars,
  checkListRows, checkDetailBands, checkSvgLabels, checkContrast,
} from '../mock2/mockup-checks-logic.js';
import { MOCKUP_BASE_CSS } from '../mock2/mockup-template.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(resolve(__dir, 'fixtures', 'spec-ops-hub-mockup.html'), 'utf8');

test('the Spec Ops Hub fixture passes the full battery', () => {
  const res = runMockupChecks(FIXTURE);
  assert.deepEqual(res.violations, []);
  assert.equal(res.ok, true);
  assert.equal(mockupChecksNote(res), '');
});

test('legacy palette and rogue hexes are caught', () => {
  assert.match(checkLegacyPalette('<style>a{color:#22C55E}</style>')[0].detail, /#22c55e/);
  assert.equal(checkLegacyPalette(FIXTURE).length, 0);
  // A hex outside the ==tokens== blocks is rogue — in CSS or inline styles.
  const rogue = checkRogueHexes(`<style>${MOCKUP_BASE_CSS}\n.card{background:#123456}</style>`);
  assert.equal(rogue.length, 1);
  assert.match(rogue[0].detail, /#123456/);
  assert.equal(checkRogueHexes(`<style>${MOCKUP_BASE_CSS}</style>`).length, 0);
  assert.match(checkRogueHexes('<div style="color:#ff0000">x</div>')[0].detail, /inline/);
});

test('theme checks: dark block, light root, working toggle all required', () => {
  assert.equal(checkThemes(FIXTURE).length, 0);
  const noDark = checkThemes('<style>:root{--bg:#fff}</style><button class="theme-toggle"></button><script>document.documentElement.dataset.theme="dark"</script>'.replace('dataset.theme', 'x'));
  assert.ok(noDark.some((x) => /data-theme="dark"/.test(x.detail)));
  assert.ok(noDark.some((x) => /nothing flips/.test(x.detail)));
});

test('bars: unbound, zero, and uniform fills are defects; varied bound fills pass', () => {
  assert.equal(checkBars(FIXTURE).length, 0);
  assert.match(checkBars('<div class="bar"></div>')[0].detail, /no --fill/);
  assert.match(checkBars('<div class="bar" style="--fill:0%"></div>')[0].detail, /zero fill/);
  const uniform = checkBars('<div class="bar" style="--fill:50%"></div><div class="bar" style="--fill:50%"></div>');
  assert.match(uniform[0].detail, /identical fill/);
  assert.equal(checkBars('<p>no bars here</p>').length, 0); // conditional — silent when unused
});

test('list rows: one metric, one mapped stage badge, a value statement — per row', () => {
  assert.equal(checkListRows(FIXTURE).length, 0);
  const row = (inner) => `<style>.list-row{display:grid;grid-template-columns:1fr}</style><section><div class="list-row">${inner}</div></section>`;
  const good = '<span class="stage-badge stage-mvp">MVP</span><div class="identity"><div class="title">T</div><div class="value-statement">v</div></div><span class="metric"><b class="num">3</b></span>';
  assert.equal(checkListRows(row(good)).length, 0);
  assert.ok(checkListRows(row(good + '<span class="metric">extra</span>')).some((x) => /2 \.metric/.test(x.detail)));
  assert.ok(checkListRows(row(good.replace(' stage-mvp', ''))).some((x) => x.check === 'stage-badges'));
  assert.ok(checkListRows(row(good.replace('value-statement', 'blurb'))).some((x) => /value-statement/.test(x.detail)));
});

test('detail bands: all three required, exactly one filled promote button', () => {
  assert.equal(checkDetailBands(FIXTURE).length, 0);
  const detail = (inner) => `<section data-screen="D" data-kind="detail">${inner}</section>`;
  const bands = '<div data-band="canvas"></div><div data-band="metrics"></div><div data-band="ladder"><button class="btn-primary">Promote to next level</button></div>';
  assert.equal(checkDetailBands(detail(bands)).length, 0);
  assert.ok(checkDetailBands(detail(bands.replace('data-band="ladder"', 'data-x="y"'))).some((x) => /missing the ladder band/.test(x.detail)));
  assert.ok(checkDetailBands(detail(bands + '<button class="btn-primary">Save</button>')).some((x) => /2 filled buttons/.test(x.detail)));
  assert.equal(checkDetailBands('<section data-screen="List">no detail here</section>').length, 0);
});

test('svg labels and computed contrast', () => {
  assert.equal(checkSvgLabels(FIXTURE).length, 0);
  assert.match(checkSvgLabels('<svg viewBox="0 0 16 16"><path d="M0 0"/></svg>')[0].detail, /neither aria-hidden/);
  assert.equal(checkContrast(FIXTURE).length, 0);
  // A washed-out --text-3 fails AA and is reported with the computed ratio.
  const weak = checkContrast('<style>:root{--text-3:#AAAAAA;--surface-1:#FFFFFF;--bg:#FFFFFF}</style>');
  assert.ok(weak.some((x) => /--text-3 on --surface-1 is/.test(x.detail)));
  assert.ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.01);
});

test('the advisory note is short and capped', () => {
  const res = { ok: false, violations: [1, 2, 3, 4, 5].map((i) => ({ check: 'c', detail: `finding ${i}` })) };
  const note = mockupChecksNote(res);
  assert.match(note, /flagged 5 item\(s\)/);
  assert.match(note, /\+2 more/);
  assert.match(note, /Advisory/);
});
