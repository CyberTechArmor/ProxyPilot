// Mock2 DESIGN SIGNALS — density and redundant status coding. Pure layer.
//
// WHY THESE TWO. The gate battery measures whether the app CAN be used: does it
// overflow, are there dead controls, does it adhere to the approved tokens.
// Nothing measured whether a screen is any good to READ, and the two properties
// that most separate a considered interface from a generated one are both
// mechanically observable in the capture the review already takes:
//
//   DENSITY — how many facts a screen puts in front of someone before they
//   scroll. Generated screens characteristically arrive airy and empty: three
//   cards, a lot of padding, and a scroll for everything that matters. It is
//   the single most reliable tell, and nobody was counting.
//
//   REDUNDANT STATUS CODING — whether "this one is a problem" is carried by
//   more than colour. A red dot with no glyph and no word is invisible to a
//   colourblind reader, illegible in a screenshot, and unsearchable — and it is
//   what a model reaches for by default.
//
// Both are ADVISORY. Neither can red a build: density is a judgement about the
// screen's job (a focused create form SHOULD be sparse), and a colour-only
// signal can be legitimate where a label sits beside it. They are measured,
// reported, and handed to the critique as evidence — which is exactly what the
// review was previously being asked to eyeball from a JPEG.
//
// PURE (stub-first, risk R9): no I/O, no browser. The in-page probe that
// produces these measurements lives in design-review.js; everything about what
// the numbers MEAN is here, where a test can reach it.

// What "enough on the screen" means, per width. Deliberately low: these are
// floors that only a genuinely empty screen falls through, not targets. Tuned
// against the shape being caught — a dashboard whose first viewport carries a
// title, three stat cards and nothing else.
export const DENSITY_FLOOR = Object.freeze({ desktop: 18, mobile: 8 });

// Below this, a screen is not sparse — it is blank, and something is wrong with
// the render, the data, or the route rather than the design.
export const EMPTY_CEILING = 3;

// Paths that are SUPPOSED to be sparse. A sign-in screen with 18 facts above
// the fold would be a defect of its own.
const SPARSE_BY_DESIGN = /^\/(login|signin|sign-in|register|signup|sign-up|forgot|reset|logout|onboarding)(\/|$)/i;

export function isSparseByDesign(path) {
  return SPARSE_BY_DESIGN.test(String(path || '/'));
}

// densityFindings(measurements) → [{ code, severity, detail }]
//
// `measurements` is [{ path, width, facts, controls, viewport }] from the probe.
// Severity is never above 'medium': this is a reading of the screen, not a
// defect. A screen that measures near-zero is called out separately, because
// "your dashboard is empty" and "your dashboard is airy" are different news.
export function densityFindings(measurements = []) {
  const out = [];
  for (const m of Array.isArray(measurements) ? measurements : []) {
    const path = String(m?.path || '/');
    if (isSparseByDesign(path)) continue;
    const facts = Number(m?.facts) || 0;
    const mobile = Number(m?.width) <= 600;
    const floor = mobile ? DENSITY_FLOOR.mobile : DENSITY_FLOOR.desktop;
    if (facts <= EMPTY_CEILING) {
      out.push({
        code: 'screen-empty',
        severity: 'medium',
        detail: `${path} shows ${facts} fact(s) above the fold at ${m.width}px. That is not a sparse screen, it is an empty one — check that the route renders its data at all.`,
      });
    } else if (facts < floor) {
      out.push({
        code: 'low-density',
        severity: 'low',
        detail: `${path} puts ${facts} fact(s) in front of someone before they scroll at ${m.width}px (a working screen of this kind carries about ${floor}). If this screen answers a question, more of the answer should be visible at once — tighten the padding, or show the rows rather than a count of them.`,
      });
    }
  }
  return out;
}

// colorOnlyFindings(signals) → [{ code, severity, detail }]
//
// `signals` is [{ path, width, total, colorOnly, examples }]. A status colour
// with no glyph and no word beside it fails for three separate people: the
// colourblind reader, the person reading a printed or screenshotted copy, and
// the person searching the page for "overdue".
export function colorOnlyFindings(signals = []) {
  const out = [];
  for (const s of Array.isArray(signals) ? signals : []) {
    const colorOnly = Number(s?.colorOnly) || 0;
    if (colorOnly < 2) continue;   // one is a dot beside a label; several is a system
    const examples = (s.examples || []).slice(0, 4).join(', ');
    out.push({
      code: 'colour-only-status',
      severity: 'medium',
      detail: `${s.path}: ${colorOnly} element(s) signal status with colour alone${examples ? ` (${examples})` : ''}. Add a glyph and a word to each — colour is the third channel, never the only one. It is also what makes a status searchable and legible in a screenshot.`,
    });
  }
  return out;
}

// The block handed to the critique as evidence, in the same voice as the
// existing overflow finding: measured, specific, and already true.
export function signalsPromptBlock({ density = [], colorOnly = [] } = {}) {
  const findings = [...density, ...colorOnly];
  if (!findings.length) {
    return 'Density and status-coding measured clean: every screen carries a working amount above the fold, and no status is signalled by colour alone.';
  }
  return `DETERMINISTIC MEASUREMENTS (already true of the running app — treat as evidence, and fold the ones that matter into your findings rather than repeating them):\n${findings.map((f) => `- ${f.detail}`).join('\n')}`;
}

// The chat lines. Bounded, because a twelve-screen app with a systemic problem
// would otherwise produce twelve near-identical lines and teach nothing.
export function signalsChatLines({ density = [], colorOnly = [] } = {}, { max = 4 } = {}) {
  const all = [...colorOnly, ...density];   // coding first: it is the accessibility one
  if (!all.length) return [];
  const lines = all.slice(0, max).map((f) => `• [${f.severity}] ${f.code}: ${f.detail}`);
  if (all.length > max) lines.push(`• …and ${all.length - max} more density/status measurement(s).`);
  return lines;
}
