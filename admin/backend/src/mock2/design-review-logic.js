// Mock2 DESIGN REVIEW pure decision layer — the "look at the screen" pass.
// Native-free, unit-tested stub-first (risk R9).
//
// The gap this closes: builds wrote CSS nobody ever rendered — output looked
// "clean but junior" because no feedback loop existed between the deployed
// pixels and the model. The review pass screenshots the LIVE app (mobile +
// desktop), sends the images plus the approved mockup + design tokens to a
// vision model, and turns the critique into findings — optionally applied as a
// quick polish build. Two deterministic checks ride along free: axe-core
// accessibility violations and a rogue-CSS-color lint (values that bypass the
// design tokens).
//
// This module owns: the critique prompt, the strict-JSON reply parse, the
// rogue-color lint, the chat summary, and the polish-build instruction.
// The native half (design-review.js) owns browsers, containers, and models.
//
// Terminology (risk R7): nothing here is named "agent".

const MAX_FINDINGS = 12;
const MAX_STR = 300;
export const REVIEW_SEVERITIES = Object.freeze(['high', 'medium', 'low']);

// The vision critique prompt. The model sees screenshots (mobile first, then
// desktop), the approved mockup HTML, and the design tokens. STRICT JSON out.
export function buildReviewPrompt() {
  return `You are a senior product designer reviewing a deployed web app against its
approved design. You are given SCREENSHOTS of the live app (mobile-width first,
then desktop where provided), the approved mockup HTML (the visual contract),
and the design tokens.

Judge like a design lead doing a polish review, not a linter:
- FIDELITY: does the app match the mockup's layout, navigation structure, and
  component arrangement? Missing bottom tab bars, changed hierarchies, and
  dropped components are HIGH severity.
- CRAFT: spacing rhythm (inconsistent gaps/padding), visual hierarchy (no clear
  primary action, competing emphasis), alignment (misaligned columns, ragged
  numeric data), typography (sizes off-scale, cramped line-height).
- STATES: bare or missing empty states ("No data" with no next action), raw
  error text, unstyled loading.
- DENSITY & POLISH: oversized placeholder-looking cards, dead whitespace,
  default-browser-looking controls, missing hover/focus affordances (where
  inferable), badge/status colors not tied to meaning.
- MOBILE: horizontal scroll, touch targets that look under 44px, layouts that
  did not collapse to one column.

Reply with STRICT JSON only — no prose, no code fences. Schema:
{
  "summary": "one sentence — overall verdict",
  "findings": [
    { "screen": "path or screen name the screenshot shows",
      "severity": "high" | "medium" | "low",
      "issue": "what is wrong, specific and visual",
      "fix": "the concrete CSS/markup-level change that fixes it" }
  ]
}
Order findings by severity. Be specific ("the stat tiles use 8px gaps where the
cards above use 16px") — never generic ("improve spacing"). An empty findings
array is a valid answer for a genuinely polished app. At most ${MAX_FINDINGS} findings.`;
}

// Tolerant reply parser (same discipline as the pre-pass): fences stripped,
// outermost object, severities validated, strings clamped. null on unusable.
export function parseReviewReply(text) {
  let s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let doc;
  try { doc = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  const clip = (v) => String(v ?? '').trim().slice(0, MAX_STR);
  const findings = (Array.isArray(doc.findings) ? doc.findings : [])
    .filter((f) => f && typeof f === 'object' && String(f.issue || '').trim())
    .slice(0, MAX_FINDINGS)
    .map((f) => ({
      screen: clip(f.screen) || '/',
      severity: REVIEW_SEVERITIES.includes(f.severity) ? f.severity : 'medium',
      issue: clip(f.issue),
      fix: clip(f.fix),
    }));
  return { summary: clip(doc.summary), findings };
}

// ---- rogue-CSS-color lint (deterministic, non-gating) ----
//
// Thought through deliberately (it was requested "thoroughly"): a hard gate on
// styling values would false-positive constantly (shadows, borders, one-off
// rgba overlays are legitimate), so this NEVER fails a build. It reports colors
// that bypass the design tokens as review findings — visibility, not blockage.
// Only colors are checked (the drift that actually changes an app's look);
// spacing/size values are too context-dependent to lint honestly.

// Every concrete color literal in a tokens JSON document (hex + rgb/hsl).
export function tokenColorSet(tokensJson) {
  const out = new Set();
  const scan = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) out.add(normalizeColor(m[0]));
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) scan(x);
    }
  };
  try { scan(typeof tokensJson === 'string' ? JSON.parse(tokensJson) : tokensJson); } catch { /* empty set */ }
  return out;
}

function normalizeColor(c) {
  let s = String(c).toLowerCase().replace(/\s+/g, '');
  // #abc → #aabbcc so shorthand matches longhand.
  const m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) s = `#${m[1][0]}${m[1][0]}${m[1][1]}${m[1][1]}${m[1][2]}${m[1][2]}`;
  return s;
}

// Colors used in a CSS text that are neither tokens (var(--…) usage is always
// fine), token literals, nor trivial neutrals (#fff/#000/transparent/inherit —
// legitimate everywhere). Returns unique offenders with a usage count.
export function rogueCssColors(cssText, tokensJson) {
  const allowed = tokenColorSet(tokensJson);
  const neutral = new Set(['#ffffff', '#000000']);
  const counts = new Map();
  // Ignore the insides of var(...) fallbacks — those ARE the token mechanism.
  const css = String(cssText || '').replace(/var\([^)]*\)/g, 'var()');
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) {
    const c = normalizeColor(m[0]);
    if (allowed.has(c) || neutral.has(c)) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()].map(([color, count]) => ({ color, count }));
}

/* ---------------------------------------------------------------------------
   DESIGN ADHERENCE — did the build USE the approved design, or re-invent it?

   On project 36 the app linked design.css and then referenced none of it: it
   declared 32 tokens of its own and hand-wrote 17,837 chars of CSS. The result
   shared the palette and reproduced nothing else, and no check noticed, because
   every existing check asks "is this app well made" rather than "is this the
   approved design".

   Deterministic, and cheap: compare the variables the app USES against the ones
   the approved stylesheet DEFINES.
   --------------------------------------------------------------------------- */

// Custom properties DEFINED by a stylesheet (`--x: value`).
export function definedCssVars(cssText) {
  const out = new Set();
  for (const m of String(cssText || '').matchAll(/(^|[;{\s])(--[a-z0-9-]+)\s*:/gi)) out.add(m[2].toLowerCase());
  return out;
}

// Custom properties USED by a stylesheet (`var(--x)`).
export function usedCssVars(cssText) {
  const out = new Set();
  for (const m of String(cssText || '').matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) out.add(m[1].toLowerCase());
  return out;
}

/* checkDesignAdherence({ designCss, appCss })
 *
 * designCss — state/design.css, the approved design carried from the mockup.
 * appCss    — every stylesheet/style block the BUILD wrote.
 *
 * Returns { ok, findings: [{ code, severity, detail }], stats }.
 * Advisory by default — the caller decides whether a finding blocks — but the
 * codes are stable so a gate can key on them.
 */
// The class selectors a stylesheet DEFINES, and the classes a page USES.
// state/design.css carries the approved mockup's component CSS verbatim, so its
// class names are the mockup's own vocabulary — cards, lists, nav bars, chips.
// Whether the built markup speaks that vocabulary is the closest deterministic
// answer to "does this look like the mockup", and no amount of variable
// counting reaches it.
export function definedCssClasses(css) {
  const out = new Set();
  for (const m of String(css || '').matchAll(/\.([A-Za-z][A-Za-z0-9_-]{2,})/g)) out.add(m[1]);
  return out;
}

export function usedHtmlClasses(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/class\s*=\s*"([^"]*)"/gi)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

export function checkDesignAdherence({ designCss = '', appCss = '', appHtml = '' } = {}) {
  const approved = definedCssVars(designCss);
  const appDefines = definedCssVars(appCss);
  // The markup counts as app styling too: inline style attributes and <style>
  // blocks reference variables, and a build that styles its screens in the HTML
  // was measuring as "no CSS at all" (project 39's shape).
  const appUses = new Set([...usedCssVars(appCss), ...usedCssVars(appHtml)]);
  const findings = [];

  // Component vocabulary — the structural half.
  const designClasses = definedCssClasses(designCss);
  const htmlClasses = usedHtmlClasses(appHtml);
  const usedClasses = [...designClasses].filter((c) => htmlClasses.has(c));
  const componentCoverage = designClasses.size ? usedClasses.length / designClasses.size : null;

  // Nothing approved to adhere to — an old project, not a defect.
  if (!approved.size) {
    return {
      ok: true,
      findings: [],
      stats: {
        approved: 0, used: 0, ownTokens: 0, coverage: 1,
        designClasses: designClasses.size, usedClasses: usedClasses.length, componentCoverage,
      },
    };
  }

  const usedApproved = [...appUses].filter((v) => approved.has(v));
  // A token the app declares itself AND that the approved design already
  // defines is a redefinition; one it declares that the design does NOT define
  // is a parallel system. Both are how "shares the colours" happens.
  const ownTokens = [...appDefines].filter((v) => !approved.has(v));
  const coverage = approved.size ? usedApproved.length / approved.size : 1;

  // A build that shipped SCREENS with no styling of its own and none of the
  // approved components has not reproduced the mockup — the exact shape that
  // shipped an app looking nothing like its contract while every check passed.
  if (String(appHtml || '').trim().length >= 2000
      && String(appCss || '').trim().length < 500
      && (componentCoverage === null || componentCoverage < 0.25)) {
    findings.push({
      code: 'SCREENS_UNSTYLED',
      severity: 'high',
      detail: `The built screens carry ${String(appHtml).trim().length} bytes of markup with ${String(appCss).trim().length} bytes of styling `
        + `and ${usedClasses.length} of ${designClasses.size} approved component classes. `
        + 'Plain elements on the base shell cannot look like the approved mockup.',
    });
  } else if (designClasses.size >= 6 && componentCoverage !== null && componentCoverage < 0.25 && String(appHtml || '').trim().length >= 2000) {
    findings.push({
      code: 'COMPONENTS_UNUSED',
      severity: 'high',
      detail: `The built screens use ${usedClasses.length} of the approved design's ${designClasses.size} component classes `
        + `(${Math.round(componentCoverage * 100)}%). The mockup's layout, navigation pattern and components are not being reproduced.`,
    });
  }

  if (appCss.trim() && usedApproved.length === 0) {
    findings.push({
      code: 'DESIGN_TOKENS_UNUSED',
      severity: 'high',
      detail: `The app's stylesheets reference NONE of the ${approved.size} approved design variables. `
        + 'The approved design is loaded and ignored — rebuild the screens on it instead of a parallel set.',
    });
  } else if (coverage < 0.25 && approved.size >= 8 && !(componentCoverage !== null && componentCoverage >= 0.25)) {
    // Not when the app consumes the design through its COMPONENTS instead: an
    // app that puts the mockup's class names on its elements references few
    // variables directly BY DESIGN, and telling it the design is unused would
    // push it into re-declaring a palette it was handed. (Caught by running the
    // review's own logic over a faithful fixture: it read 12/12 components and
    // still complained about 4/34 variables.)
    findings.push({
      code: 'DESIGN_TOKENS_BARELY_USED',
      severity: 'medium',
      detail: `The app uses only ${usedApproved.length} of ${approved.size} approved design variables `
        + `(${Math.round(coverage * 100)}%). Most of the approved design is not being reproduced.`,
    });
  }

  if (ownTokens.length >= 12) {
    findings.push({
      code: 'PARALLEL_TOKEN_SYSTEM',
      severity: 'high',
      detail: `The app declares ${ownTokens.length} design variables of its own `
        + `(${ownTokens.slice(0, 6).join(', ')}${ownTokens.length > 6 ? ', …' : ''}) on top of the approved set. `
        + 'Two palettes drift apart; build on the approved variables.',
    });
  }

  // The mockup ships a dark theme. If the approved design has one and the app
  // does not, the theme toggle flips an attribute nothing responds to — which
  // is a visibly broken feature, not a style opinion.
  const designDark = /\[data-theme=["']?dark["']?\]/.test(designCss);
  const appDark = /\[data-theme=["']?dark["']?\]/.test(appCss);
  if (designDark && !appDark && appDefines.size > 0) {
    findings.push({
      code: 'DARK_THEME_DROPPED',
      severity: 'high',
      detail: 'The approved design defines a dark theme; the app defines its own tokens with no dark variant, '
        + 'so the theme toggle changes nothing for those values.',
    });
  }

  return {
    ok: findings.every((f) => f.severity !== 'high'),
    findings,
    stats: {
      approved: approved.size, used: usedApproved.length, ownTokens: ownTokens.length, coverage,
      designClasses: designClasses.size, usedClasses: usedClasses.length, componentCoverage,
    },
  };
}

// ---- output composition ----

// The chat message a review posts (manual Polish pass or the after-build pass).
export function reviewChatMessage({ review, axe = [], rogue = [], adherence = null, trigger = 'manual', screenshotCount = 0 }) {
  const lines = [];
  const label = trigger === 'auto' ? 'Design review (after build)' : 'Design review (Polish pass)';
  const n = review?.findings?.length || 0;
  lines.push(`${label} — ${screenshotCount} screenshot(s) reviewed. ${review?.summary || (n ? `${n} finding(s).` : 'No findings — the app matches its design well.')}`);

  // DRIFT FIRST.
  //
  // "Does the shipped app still look like the approved mockup" is the question
  // this review exists to answer, and it used to be a footnote below the
  // accessibility list — printed only when there were findings, so an app that
  // had drifted badly could read as clean. It is now the second line, always,
  // with the arithmetic behind it: the critique above is taste, this is
  // measurement over the shipped files.
  if (adherence?.stats) {
    const { approved = 0, used = 0, ownTokens = 0, designClasses = 0, usedClasses = 0 } = adherence.stats;
    if (approved > 0) {
      const drifted = (adherence.findings || []).some((f) => f.severity === 'high');
      const parts = [`${used}/${approved} approved design variable(s)`];
      if (designClasses > 0) parts.push(`${usedClasses}/${designClasses} approved component class(es)`);
      if (ownTokens > 0) parts.push(`${ownTokens} variable(s) of its own`);
      lines.push(`${drifted ? '**Visual drift** — the shipped app has moved away from the approved design.' : 'Design adherence:'} The app uses ${parts.join(', ')}.`);
    }
  }
  for (const f of review?.findings || []) {
    lines.push(`• [${f.severity}] ${f.screen}: ${f.issue}${f.fix ? ` — fix: ${f.fix}` : ''}`);
  }
  const serious = axe.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  if (serious.length) {
    lines.push(`Accessibility (axe-core): ${serious.length} serious/critical issue(s):`);
    for (const v of serious.slice(0, 8)) lines.push(`• [${v.impact}] ${v.page}: ${v.help} (${v.id})`);
  }
  if (rogue.length) {
    lines.push(`Token drift: ${rogue.length} color(s) used outside the design tokens (advisory, not a gate): ${rogue.slice(0, 6).map((r) => `${r.color}×${r.count}`).join(', ')}.`);
  }
  // The adherence findings themselves — the numbers already led the message.
  for (const f of adherence?.findings || []) lines.push(`• [${f.severity}] ${f.code}: ${f.detail}`);
  return lines.join('\n');
}

// The quick-build instruction "Apply the fixes" composes. Binding, scoped to
// polish — it must never grow features.
export function composePolishInstruction({ review, axe = [], rogue = [], adherence = null }) {
  const items = [];
  for (const f of review?.findings || []) {
    items.push(`${f.screen}: ${f.issue}${f.fix ? ` — ${f.fix}` : ''}`);
  }
  for (const v of axe.filter((x) => x.impact === 'critical' || x.impact === 'serious').slice(0, 8)) {
    items.push(`${v.page}: fix the accessibility violation "${v.help}" (axe rule ${v.id})`);
  }
  if (rogue.length) {
    items.push(`replace hardcoded colors that bypass the design tokens (${rogue.slice(0, 6).map((r) => r.color).join(', ')}) with the matching var(--app-*) tokens`);
  }
  // Adherence findings first in the operator's mind but last in the list: they
  // are the largest edits, so they read better after the specific screen fixes.
  for (const f of adherence?.findings || []) {
    items.push(`design system: ${f.detail}`);
  }
  if (!items.length) return null;
  return 'Design polish pass — apply EXACTLY these visual fixes, no new features, no behavior changes:\n'
    + items.map((s, i) => `${i + 1}. ${s}`).join('\n')
    + '\nKeep every fix inside the design tokens (var(--app-*)); do not restyle anything not listed.';
}
