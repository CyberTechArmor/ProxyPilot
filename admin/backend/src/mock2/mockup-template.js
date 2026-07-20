// Mock2 mockup base template — the token stylesheet every generated mockup
// includes verbatim. This is the structural half of the design system: the
// design-system markdown (framework-seed/design-system.md) says WHAT the
// tokens mean; this module is the machine-readable source the render prompt
// injects and the verification checks parse. One source — the markdown tables,
// the prompt CSS, and the checks can never drift apart.
//
// Light is the REFERENCE theme (:root); dark derives via [data-theme="dark"]
// on <html>, flipped by the header toggle. Every color in a mockup routes
// through these custom properties — component CSS carries ZERO hex literals.
// A brief's explicit spec or the project's chosen base theme re-VALUES the
// properties (same names, new values); nothing ever bypasses them.
//
// PURE (stub-first, risk R9): string/table literals only — no I/O, no native
// modules. Terminology (risk R7): nothing here is named "agent".

// All AA-verified pairings (computed, not eyeballed): text-1/2/3 vs surface-1
// and bg, accent-on vs accent, status colors vs surface-1, and every stage
// badge text vs its tinted badge background — in BOTH themes, ≥ 4.5:1.
export const MOCKUP_TOKENS = Object.freeze({
  light: Object.freeze({
    bg: '#F6F8F8', 'surface-1': '#FFFFFF', 'surface-2': '#EFF3F3', 'surface-3': '#E6EDEC',
    'text-1': '#16201F', 'text-2': '#3F4F4D', 'text-3': '#5F716E',
    hairline: 'rgba(22,32,31,.12)',
    accent: '#0F766E', 'accent-on': '#FFFFFF',
    danger: '#B42318', warn: '#9A5B00', ok: '#067647',
    'shadow-1': '0 1px 2px rgba(22,32,31,.06), 0 6px 20px rgba(22,32,31,.07)',
  }),
  dark: Object.freeze({
    // Soft dark surfaces — never pure black; muted accent, same hue family.
    bg: '#101617', 'surface-1': '#161D1E', 'surface-2': '#1D2627', 'surface-3': '#243030',
    'text-1': '#E6EBEA', 'text-2': '#AEBCB9', 'text-3': '#8FA09D',
    hairline: 'rgba(230,235,234,.12)',
    accent: '#3FB8AC', 'accent-on': '#06201D',
    danger: '#E5756A', warn: '#E0A64E', ok: '#58B98A',
    'shadow-1': '0 1px 2px rgba(0,0,0,.5), 0 6px 20px rgba(0,0,0,.35)',
  }),
  // Full lifecycle-stage palette — badge = tinted background + same-hue text
  // (darker in light, lighter in dark). Every stage is mapped; NO stage may
  // fall through to a neutral default.
  stages: Object.freeze({
    ideation: Object.freeze({ label: 'Ideation', light: { bg: '#E7EBF0', text: '#44546A' }, dark: { bg: '#232B36', text: '#AAB9CC' } }),
    mvp: Object.freeze({ label: 'MVP', light: { bg: '#E6E9F9', text: '#3F48A8' }, dark: { bg: '#262A4A', text: '#AEB6F2' } }),
    testing: Object.freeze({ label: 'Testing', light: { bg: '#F6EDD9', text: '#7A5A14' }, dark: { bg: '#37301B', text: '#D9BA6E' } }),
    iterating: Object.freeze({ label: 'Iterating', light: { bg: '#F6E7D9', text: '#8A4A1F' }, dark: { bg: '#382A1E', text: '#DCA97C' } }),
    rollout: Object.freeze({ label: 'Rollout', light: { bg: '#DFF0ED', text: '#0E5F58' }, dark: { bg: '#1C3330', text: '#82CCC2' } }),
    maintenance: Object.freeze({ label: 'Maintenance', light: { bg: '#E3F0E5', text: '#2E6B3B' }, dark: { bg: '#223026', text: '#96CDA5' } }),
  }),
});

// The two token blocks, generated from MOCKUP_TOKENS so markdown/prompt/checks
// share one source. The ==tokens== markers let the verification checks find
// the ONLY region where hex literals are allowed.
export function mockupTokenCss(tokens = MOCKUP_TOKENS) {
  const vars = (theme) => Object.entries(theme).map(([k, v]) => `  --${k}: ${v};`).join('\n');
  const stageVars = (mode) => Object.entries(tokens.stages)
    .map(([k, s]) => `  --stage-${k}-bg: ${s[mode].bg};\n  --stage-${k}-text: ${s[mode].text};`)
    .join('\n');
  return `/* ==tokens== (the only place hex colors may appear) */
:root {
${vars(tokens.light)}
${stageVars('light')}
}
[data-theme="dark"] {
${vars(tokens.dark)}
${stageVars('dark')}
}
/* ==/tokens== */`;
}

// The base stylesheet a mockup includes VERBATIM as the start of its <style>.
// Everything below the token blocks routes through var(--…) — zero hex.
export const MOCKUP_BASE_CSS = `${mockupTokenCss()}
html { background: var(--bg); }
body {
  margin: 0; background: var(--bg); color: var(--text-1);
  font-family: Manrope, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px; line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
.surface { background: var(--surface-1); box-shadow: var(--shadow-1); border-radius: 12px; }
.hairline { border-bottom: 1px solid var(--hairline); }
h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
h2 { font-size: 16px; font-weight: 600; margin: 0; }
.t-label { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text-3); }
.t-quiet { color: var(--text-2); }
.t-faint { color: var(--text-3); }
.num { font-variant-numeric: tabular-nums; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.theme-toggle {
  min-width: 44px; min-height: 44px; padding: 0 12px; border-radius: 10px;
  border: 1px solid var(--hairline); background: var(--surface-2);
  color: var(--text-2); cursor: pointer; font: inherit;
}
.btn-primary {
  min-height: 44px; padding: 0 18px; border: 0; border-radius: 10px;
  background: var(--accent); color: var(--accent-on);
  font: inherit; font-weight: 600; cursor: pointer;
}
.btn-quiet {
  min-height: 44px; padding: 0 14px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--hairline); background: transparent; color: var(--text-2); font: inherit;
}
/* Canonical list row — Stage badge | Identity | Headline metric | Position | Lead · Updated.
   Identity gets minmax(0,1fr) + min-width:0 so the value statement TRUNCATES
   instead of overlapping the metric column (the worst observed defect). */
.list-row {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr) 190px 140px 170px;
  gap: 16px; align-items: center;
  padding: 12px 16px; background: var(--surface-1);
  border-bottom: 1px solid var(--hairline);
}
.list-row > * { min-width: 0; }
.identity .title { font-size: 16px; font-weight: 600; }
.identity .value-statement {
  font-size: 13px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
@media (max-width: 639px) {
  .list-row { grid-template-columns: max-content minmax(0, 1fr); row-gap: 6px; align-items: start; }
}
/* Data-carrying bar — the fill binds to a value via --fill; a bar with no
   value behind it is not rendered at all. */
.bar { position: relative; height: 8px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.bar::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 0;
  width: var(--fill, 0%); border-radius: inherit; background: var(--accent);
}
/* Stage badges — the complete map; every stage resolves to its own hue pair,
   no stage falls through to a neutral default. */
.stage-badge {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 4px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 600; white-space: nowrap;
}
.stage-ideation { background: var(--stage-ideation-bg); color: var(--stage-ideation-text); }
.stage-mvp { background: var(--stage-mvp-bg); color: var(--stage-mvp-text); }
.stage-testing { background: var(--stage-testing-bg); color: var(--stage-testing-text); }
.stage-iterating { background: var(--stage-iterating-bg); color: var(--stage-iterating-text); }
.stage-rollout { background: var(--stage-rollout-bg); color: var(--stage-rollout-text); }
.stage-maintenance { background: var(--stage-maintenance-bg); color: var(--stage-maintenance-text); }
/* One metric per item, formatted value → unit → descriptor. */
.metric { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.metric .num { font-size: 16px; font-weight: 600; }
.metric .unit { font-size: 12px; color: var(--text-2); }
.metric .desc { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; }
/* Detail-page building blocks: stat tiles, attention chips, rollout ladder. */
.stat-tile { padding: 16px; border-radius: 12px; background: var(--surface-2); }
.chip-warn {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
  border-radius: 999px; font-size: 12px; font-weight: 600;
  background: var(--surface-2); color: var(--warn);
}
.ladder-level {
  display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;
  padding: 12px 16px; border-radius: 10px; background: var(--surface-2);
}
.ladder-level.frontier { background: var(--surface-1); outline: 2px solid var(--accent); }
.check-quiet { display: flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 13px; }
.check-quiet svg { color: var(--ok); }`;

// The theme toggle behavior — flips data-theme on <html>. Light is the
// reference theme (no attribute); the toggle adds/removes "dark".
export const MOCKUP_THEME_TOGGLE_JS = `function toggleTheme() {
  var r = document.documentElement;
  r.dataset.theme = r.dataset.theme === 'dark' ? '' : 'dark';
}`;
