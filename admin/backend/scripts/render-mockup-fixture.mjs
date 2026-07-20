#!/usr/bin/env node
// Compose the Spec Ops Hub fixture mockup from the harness's own base
// template + the design system's sample-data section (§8), and write it to
// src/__tests__/fixtures/spec-ops-hub-mockup.html. The fixture is the proof
// artifact for the acceptance checks (mockup-checks-logic.js): it exercises
// the canonical list row, data-bound bars, the three detail bands, the full
// stage palette, and both themes — using ONLY token-routed styling.
//
// Deterministic on purpose (no dates, no randomness): re-running it must
// reproduce the committed fixture byte-for-byte.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCKUP_BASE_CSS, MOCKUP_THEME_TOGGLE_JS } from '../src/mock2/mockup-template.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '..', 'src', '__tests__', 'fixtures', 'spec-ops-hub-mockup.html');

// §8 sample data — one entity per stage, one consistent description, stage-
// appropriate headline metrics (value → unit → descriptor), partial
// completion everywhere except Maintenance.
const ROWS = [
  { stage: 'ideation', title: 'Async intake triage', value: 'Cut phone-tag on routine refill requests before they queue', num: '42', unit: 'hrs/wk', desc: 'staff time reclaimed (proj.)', pos: 'Site · Northgate', lead: 'M. Okafor · 2d' },
  { stage: 'mvp', title: 'Barcode med checks', value: 'Scan-verify against the MAR at bedside before administration', num: '3', unit: 'sites', desc: 'piloting', pos: 'POD · North', lead: 'J. Reyes · 5h' },
  { stage: 'testing', title: 'Shift-handoff scripts', value: 'Structured handoffs so nothing rides on memory at 7am', num: '78', unit: '%', desc: 'handoffs using script', pos: 'POD · Central', lead: 'A. Whitfield · 1d' },
  { stage: 'iterating', title: 'Fall-risk rounding', value: "Hourly rounding tuned to each unit's actual fall pattern", num: '61', unit: '%', desc: 'rooms rounded on time', pos: 'Region · East', lead: 'K. Tanaka · 3h' },
  { stage: 'rollout', title: 'Rapid-response huddles', value: 'Two-minute huddle when early-warning scores trip', num: '8 of 12', unit: 'PODs', desc: 'live', pos: 'Region · East', lead: '6d', chip: 'Roller unassigned' },
  { stage: 'maintenance', title: 'Hand-hygiene audits', value: 'Passive audit loop keeping compliance from drifting', num: '100', unit: '%', desc: 'coverage sustained', pos: 'All org', lead: 'S. Adeyemi · 12d' },
];
const STAGE_LABELS = { ideation: 'Ideation', mvp: 'MVP', testing: 'Testing', iterating: 'Iterating', rollout: 'Rollout', maintenance: 'Maintenance' };

const checkIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';

const listRows = ROWS.map((r) => `
      <div class="list-row">
        <span class="stage-badge stage-${r.stage}">${STAGE_LABELS[r.stage]}</span>
        <div class="identity">
          <div class="title">${r.title}${r.chip ? ` <span class="chip-warn">${r.chip}</span>` : ''}</div>
          <div class="value-statement">${r.value}</div>
        </div>
        <span class="metric"><b class="num">${r.num}</b><span class="unit">${r.unit}</span><span class="desc">${r.desc}</span></span>
        <span class="t-quiet num">${r.pos}</span>
        <span class="t-faint">${r.lead}</span>
      </div>`).join('');

const impactBars = [
  ['Nurses', 82], ['Physicians', 54], ['Techs', 37],
].map(([who, pct]) => `
          <div class="impact-row">
            <span class="t-quiet">${who}</span>
            <div class="bar" style="--fill:${pct}%"></div>
            <span class="num t-faint">${pct}%</span>
          </div>`).join('');

const ladder = [
  ['Site', '1 of 1', false, true], ['POD', '8 of 12', true, false], ['Region', '0 of 4', false, false], ['All org', '0 of 1', false, false],
].map(([lvl, count, frontier, done]) => `
          <div class="ladder-level${frontier ? ' frontier' : ''}">
            <span>${done ? `${checkIcon} ` : ''}${lvl}</span>
            <span class="num t-quiet">${count}</span>
          </div>`).join('');

const html = `<!doctype html>
<!-- DESIGN RATIONALE: Spec Ops Hub is an operator surface scanned under time
pressure — a practice-rollout portfolio for clinical ops leads. The list is
built to answer one question per row (the stage-appropriate headline metric);
the detail page is built to answer "is this ready to promote". Light is the
reference theme (ward offices, daylight); dark derives for overnight
leads. One accent (clinical teal) carries every action; stage hues are
status, never decoration. This fixture doubles as the acceptance-check proof
artifact — every color routes through the token custom properties. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spec Ops Hub — mockup fixture</title>
<style>
${MOCKUP_BASE_CSS}
/* fixture-local layout — tokens only, zero hex */
.wrap { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; }
.toolbar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 24px; }
.toolbar h1 { margin-right: auto; }
.list { border-radius: 12px; overflow: hidden; }
.detail-grid { display: grid; grid-template-columns: 1fr; gap: 24px; }
.band { padding: 20px; border-radius: 12px; }
.impact-row { display: grid; grid-template-columns: 96px 1fr 48px; gap: 12px; align-items: center; margin-top: 12px; }
.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.ladder { display: grid; gap: 8px; margin-top: 12px; }
.checks { display: grid; gap: 8px; margin-top: 16px; }
.detail-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
section[data-screen] { display: none; }
section[data-screen].on { display: block; }
@media (max-width: 639px) { .tiles { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="toolbar surface">
    <h1>Spec Ops Hub</h1>
    <button class="btn-quiet" id="nav-list" onclick="showScreen('Initiatives')">Initiatives</button>
    <button class="btn-quiet" id="nav-detail" onclick="showScreen('Initiative detail')">Detail</button>
    <button class="theme-toggle" onclick="toggleTheme()">Theme</button>
  </header>

  <section data-screen="Initiatives" class="on">
    <div class="list surface">${listRows}
    </div>
  </section>

  <section data-screen="Initiative detail" data-kind="detail">
    <div class="detail-head" style="margin-bottom: 16px">
      <span class="stage-badge stage-rollout">Rollout</span>
      <h1>Rapid-response huddles</h1>
      <span class="chip-warn">Roller unassigned</span>
    </div>
    <div class="detail-grid">
      <div class="band surface" data-band="canvas">
        <h2>Opportunity canvas</h2>
        <p class="t-quiet">Two-minute huddle when early-warning scores trip — cut the distance between "the numbers moved" and "someone came".</p>
        <div class="t-label" style="margin-top: 16px">Audience impact</div>${impactBars}
      </div>
      <div class="band surface" data-band="metrics">
        <h2>Outcomes so far</h2>
        <div class="tiles">
          <div class="stat-tile"><span class="metric"><b class="num">4.2</b><span class="unit">min</span><span class="desc">median response</span></span></div>
          <div class="stat-tile"><span class="metric"><b class="num">31</b><span class="unit">%</span><span class="desc">fewer code events</span></span></div>
          <div class="stat-tile"><span class="metric"><b class="num">12 of 12</b><span class="unit">PODs</span><span class="desc">trained</span></span></div>
        </div>
      </div>
      <div class="band surface" data-band="ladder">
        <h2>Rollout ladder</h2>
        <div class="ladder">${ladder}
        </div>
        <div class="checks">
          <div class="check-quiet">${checkIcon} Training complete across the frontier PODs</div>
          <div class="check-quiet">${checkIcon} Supplies staged at every station</div>
          <div class="check-quiet">${checkIcon} Escalation path signed off by the region lead</div>
        </div>
        <div style="margin-top: 16px">
          <button class="btn-primary">Promote to next level</button>
        </div>
      </div>
    </div>
  </section>
</div>
<script>
${MOCKUP_THEME_TOGGLE_JS}
function showScreen(name) {
  document.querySelectorAll('section[data-screen]').forEach(function (s) {
    s.classList.toggle('on', s.dataset.screen === name);
  });
}
</script>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${html.length} bytes)`);
