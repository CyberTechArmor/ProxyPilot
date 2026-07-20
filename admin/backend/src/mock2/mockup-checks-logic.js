// Mock2 mockup checks — deterministic lint over a GENERATED mockup document,
// mirroring the design system's acceptance checks (framework-seed/
// design-system.md §7). The concept stage runs it after every render and
// surfaces findings as an ADVISORY note (never blocks a save — the Builder
// judges the design; the checks catch regressions before a human reviews).
//
// Component checks are CONDITIONAL: bars are checked only if the document
// renders bars, detail bands only if a section is marked data-kind="detail",
// list rows only if .list-row is used — so a kiosk mockup with no lists is
// not spammed. Palette/theme/token checks always run.
//
// PURE (stub-first, risk R9): regex/string analysis + WCAG math only — no
// I/O, no DOM library, no native modules. Terminology (risk R7): nothing
// here is named "agent".

// The retired v1 palette: neon greens + the near-black surface ramp. Zero
// occurrences allowed anywhere in generated output.
export const LEGACY_HEXES = Object.freeze([
  '#22c55e', '#16a34a', '#4ade80', '#070b11', '#0a0f18', '#0d1420', '#0f1621',
]);

export const STAGE_KEYS = Object.freeze(['ideation', 'mvp', 'testing', 'iterating', 'rollout', 'maintenance']);

const v = (check, detail) => ({ check, detail });

// ---- palette / token checks (always run) ----

export function checkLegacyPalette(html) {
  const s = String(html || '').toLowerCase();
  return LEGACY_HEXES.filter((h) => s.includes(h)).map((h) => v('legacy-palette', `retired v1 color ${h} present`));
}

// Hex literals are allowed ONLY inside the ==tokens== … ==/tokens== blocks.
// Everything else — component CSS and inline style attributes — must route
// through var(--…).
export function checkRogueHexes(html) {
  const s = String(html || '');
  const out = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleRe.exec(s)) !== null) {
    const css = m[1].replace(/\/\* ==tokens== [\s\S]*?==\/tokens== \*\//g, '');
    for (const hex of css.match(/#[0-9a-fA-F]{3,8}\b/g) || []) {
      out.push(v('rogue-hex', `hard-coded ${hex} in component CSS (outside the token blocks)`));
    }
  }
  for (const attr of s.match(/style="[^"]*#[0-9a-fA-F]{3,8}[^"]*"/g) || []) {
    out.push(v('rogue-hex', `hard-coded color in inline ${attr.slice(0, 60)}`));
  }
  return out;
}

export function checkThemes(html) {
  const s = String(html || '');
  const out = [];
  if (!/\[data-theme="dark"\]/.test(s)) out.push(v('themes', 'no [data-theme="dark"] token block — the dark variant is mandatory'));
  if (!/:root\s*\{/.test(s)) out.push(v('themes', 'no :root token block — light is the reference theme'));
  if (!/theme-toggle/.test(s)) out.push(v('themes', 'no .theme-toggle control in the header'));
  if (!/dataset\.theme|setAttribute\(\s*['"]data-theme['"]/.test(s)) out.push(v('themes', 'nothing flips data-theme — the toggle must work'));
  return out;
}

// ---- component checks (conditional on the pattern being used) ----

// Every .bar carries a bound --fill value > 0; sibling bars vary. An empty
// uniform track wall was an observed defect class.
export function checkBars(html) {
  const s = String(html || '');
  const bars = s.match(/<[a-z][^>]*class="[^"]*\bbar\b[^"]*"[^>]*>/gi) || [];
  if (!bars.length) return [];
  const out = [];
  const fills = [];
  for (const tag of bars) {
    const f = /--fill:\s*([\d.]+)%/.exec(tag);
    if (!f) out.push(v('bars', `a .bar has no --fill value bound: ${tag.slice(0, 80)}`));
    else if (Number(f[1]) <= 0) out.push(v('bars', `a .bar has a zero fill — a bar with no value must not be rendered`));
    else fills.push(Number(f[1]));
  }
  if (fills.length >= 2 && new Set(fills).size === 1) {
    out.push(v('bars', `all ${fills.length} bars have the identical fill ${fills[0]}% — fills must reflect (varied) data`));
  }
  return out;
}

// Split the doc into .list-row chunks and check each: exactly one .metric,
// exactly one .stage-badge with a known stage class.
export function checkListRows(html) {
  const s = String(html || '');
  const starts = [];
  const re = /<[a-z][^>]*class="[^"]*\blist-row\b[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(s)) !== null) starts.push(m.index);
  if (!starts.length) return [];
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const chunk = s.slice(starts[i], starts[i + 1] ?? s.indexOf('</section>', starts[i]));
    const metrics = (chunk.match(/class="[^"]*\bmetric\b[^"]*"/g) || []).length;
    if (metrics !== 1) out.push(v('list-rows', `row ${i + 1} has ${metrics} .metric elements — exactly one headline metric per row`));
    const badgeTags = chunk.match(/class="[^"]*\bstage-badge\b[^"]*"/g) || [];
    if (badgeTags.length !== 1) out.push(v('list-rows', `row ${i + 1} has ${badgeTags.length} stage badges — exactly one per row`));
    for (const b of badgeTags) {
      if (!STAGE_KEYS.some((k) => b.includes(`stage-${k}`))) {
        out.push(v('stage-badges', `row ${i + 1}: a .stage-badge lacks a stage class (neutral fallback): ${b.slice(0, 80)}`));
      }
    }
    if (!/class="[^"]*\bvalue-statement\b/.test(chunk)) out.push(v('list-rows', `row ${i + 1} has no .value-statement under Identity`));
  }
  // The canonical grid must be defined for the pattern to hold.
  if (!/\.list-row\s*\{[^}]*grid-template-columns/s.test(s)) {
    out.push(v('list-rows', '.list-row grid is not defined — include the base stylesheet verbatim'));
  }
  return out;
}

// Detail sections (data-kind="detail"): all three bands, one filled promote
// button, varied canvas bars (the bars check covers fill variance globally).
export function checkDetailBands(html) {
  const s = String(html || '');
  const out = [];
  const re = /<section\b[^>]*data-kind="detail"[^>]*>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const end = s.indexOf('</section>', m.index);
    const sec = s.slice(m.index, end === -1 ? s.length : end);
    const name = /data-screen="([^"]+)"/.exec(sec)?.[1] || 'detail';
    for (const band of ['canvas', 'metrics', 'ladder']) {
      if (!sec.includes(`data-band="${band}"`)) out.push(v('detail-bands', `detail screen "${name}" is missing the ${band} band`));
    }
    const filled = (sec.match(/class="[^"]*\bbtn-primary\b[^"]*"/g) || []).length;
    if (filled !== 1) out.push(v('detail-bands', `detail screen "${name}" has ${filled} filled buttons — exactly one (Promote to next level)`));
    if (sec.includes('data-band="ladder"') && !/promote to next level/i.test(sec)) {
      out.push(v('detail-bands', `detail screen "${name}": the ladder's filled button must be "Promote to next level"`));
    }
  }
  return out;
}

export function checkSvgLabels(html) {
  const s = String(html || '');
  const out = [];
  const re = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
  let m;
  let i = 0;
  while ((m = re.exec(s)) !== null) {
    i++;
    if (!/aria-hidden="true"/.test(m[0]) && !/<title>/.test(m[0])) {
      out.push(v('svg-labels', `svg #${i} is neither aria-hidden beside a label nor titled`));
    }
  }
  return out;
}

// ---- computed contrast (from the document's OWN token blocks) ----

function relLum(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// Parse --name: #hex pairs out of a CSS block body.
function parseVars(block) {
  const map = {};
  for (const [, name, hex] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\b/g)) map[name] = hex;
  return map;
}

export function extractThemeTokens(html) {
  const s = String(html || '');
  const root = /:root\s*\{([^}]*)\}/.exec(s);
  const dark = /\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(s);
  return {
    light: root ? parseVars(root[1]) : null,
    dark: dark ? parseVars(dark[1]) : null,
  };
}

// AA (≥ 4.5:1) for the text ramp, accent-on, and every stage badge pair —
// computed from the tokens the document actually ships, both themes.
export function checkContrast(html) {
  const { light, dark } = extractThemeTokens(html);
  const out = [];
  for (const [mode, t] of [['light', light], ['dark', dark]]) {
    if (!t) continue; // theme presence is checkThemes' finding
    const need = (fg, bg, label) => {
      if (!t[fg] || !t[bg]) return;
      const r = contrastRatio(t[fg], t[bg]);
      if (r < 4.5) out.push(v('contrast', `${mode}: --${fg} on --${bg} is ${r.toFixed(2)}:1 (< 4.5) — adjust lightness within-hue`));
    };
    for (const key of ['text-1', 'text-2', 'text-3']) { need(key, 'surface-1'); need(key, 'bg'); }
    need('accent-on', 'accent');
    for (const k of STAGE_KEYS) need(`stage-${k}-text`, `stage-${k}-bg`);
  }
  return out;
}

// ---- the battery ----

export function runMockupChecks(html) {
  const violations = [
    ...checkLegacyPalette(html),
    ...checkRogueHexes(html),
    ...checkThemes(html),
    ...checkBars(html),
    ...checkListRows(html),
    ...checkDetailBands(html),
    ...checkSvgLabels(html),
    ...checkContrast(html),
  ];
  return { ok: violations.length === 0, violations };
}

// One short advisory line for the Builder-facing system note ('' when clean).
export function mockupChecksNote(result) {
  if (!result || result.ok) return '';
  const shown = result.violations.slice(0, 3).map((x) => x.detail);
  const more = result.violations.length - shown.length;
  return `Design checks flagged ${result.violations.length} item(s): ${shown.join('; ')}${more > 0 ? `; +${more} more` : ''}. (Advisory — ask for a revision if any matter.)`;
}
