// Mock2 DESIGN PROMOTION — growing the approved vocabulary. Pure layer.
//
// WHY THIS EXISTS. state/design.css is generated from the approved mockup and
// everything downstream is judged against it: the adherence gate counts the
// mockup's class names in the built markup, the design review compares screens
// to the same contract. That vocabulary is frozen at the moment the operator
// has seen the least — one mockup, before a single screen was used in anger.
//
// A screen invented in build six therefore has NO approved classes by
// construction. The build that thought of a better element scored worse than
// the build that traced, and there was no mechanism by which a good new idea
// could ever become part of the design. The system could only be adhered to,
// never extended.
//
// Promotion is that mechanism, and it is deliberately the operator's call: the
// platform surfaces what a build invented, says whether it is built out of the
// design system or beside it, and an accepted element is appended to
// state/design.css — after which it IS the approved design. Later builds
// inherit it, the adherence gate counts it, and the review compares against it.
//
// PURE (stub-first, risk R9): no I/O, no native modules. Terminology (risk R7):
// nothing here is named "agent".

// The fence promoted rules live behind, so a later re-approval can regenerate
// everything ABOVE it from the mockup without discarding what the operator
// accepted, and a promotion can be replayed idempotently.
export const PROMOTED_BEGIN = '/* ==promoted== elements accepted from a build. Regenerating the design from the mockup keeps this block. */';
export const PROMOTED_END = '/* ==/promoted== */';

// A promoted element is a component, not a stylesheet. The bound is here so a
// build cannot launder a 40KB parallel theme into the approved design one
// "element" at a time.
export const MAX_RULE_CHARS = 4000;
export const MAX_PROMOTE_AT_ONCE = 12;

// Blank out comments and string literals so a brace or a semicolon inside them
// cannot move the scanner. Same technique as the import checker, same reason:
// a regex that does not know what a comment is will eventually meet one.
function blankNonCode(css) {
  const s = String(css || '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end === -1 ? s.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i];
      let j = i + 1;
      while (j < s.length && s[j] !== quote) { if (s[j] === '\\') j++; j++; }
      const stop = Math.min(j + 1, s.length);
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

// Top-level `prelude { body }` blocks, as offsets into the ORIGINAL source (the
// scan runs on the blanked copy; the slices come from the real one, so comments
// and content strings survive promotion intact).
function topLevelBlocks(css) {
  const src = String(css || '');
  const scan = blankNonCode(src);
  const blocks = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = -1;
  for (let i = 0; i < scan.length; i++) {
    const ch = scan[i];
    if (ch === '{') {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && bodyStart !== -1) {
        blocks.push({
          prelude: src.slice(preludeStart, bodyStart).trim(),
          // The prelude with comments and strings blanked. Selectors are read
          // from THIS: a prelude runs from the end of the previous block, so it
          // carries any comment sitting above the rule, and a class name
          // mentioned in that comment would otherwise be read as a selector.
          preludeCode: scan.slice(preludeStart, bodyStart).trim(),
          body: src.slice(bodyStart + 1, i),
          bodyCode: scan.slice(bodyStart + 1, i),
          text: src.slice(preludeStart, i + 1).trim(),
        });
        preludeStart = i + 1;
        bodyStart = -1;
      }
      if (depth < 0) depth = 0;
    } else if (depth === 0 && ch === ';' && bodyStart === -1) {
      // A statement at-rule (@import, @charset). Not a block; skip past it.
      preludeStart = i + 1;
    }
  }
  return blocks;
}

const CONDITIONAL_AT = /(^|\s)@(media|supports|container|layer)\b/i;

// The prelude with any preceding comment/whitespace stripped — what the rule
// actually starts with, so `@media` is recognised even when a comment sits
// above it and a selector is not mistaken for an at-rule.
function atPrelude(preludeCode) {
  return String(preludeCode || '').trim();
}

// Every class name a selector applies to. One-character names are real (`.g`),
// so the minimum is one letter — a leading digit is what tells `1.5rem` apart
// from a class, and preludes are read from the comment-blanked copy anyway.
function selectorClasses(prelude) {
  return new Set((String(prelude || '').match(/\.[A-Za-z][A-Za-z0-9_-]*/g) || []).map((c) => c.slice(1)));
}

// classRules(css) → Map<className, ruleText[]>.
//
// Conditional at-rules are descended into and RE-WRAPPED, so promoting an
// element brings its responsive rules with it. Dropping those would promote a
// component that looks right on a laptop and overflows on a phone — in a
// codebase whose mobile rules are a merge gate, that is not a detail.
export function classRules(css) {
  const out = new Map();
  const add = (name, text) => {
    if (!out.has(name)) out.set(name, []);
    const list = out.get(name);
    if (!list.includes(text)) list.push(text);
  };
  for (const block of topLevelBlocks(css)) {
    // The at-rule test reads the CODE prelude, not the raw one: a rule preceded
    // by a comment that happens to start with "@media" is still a rule.
    if (CONDITIONAL_AT.test(block.preludeCode)) {
      for (const inner of topLevelBlocks(block.body)) {
        if (CONDITIONAL_AT.test(inner.preludeCode)) continue; // one level is enough
        for (const name of selectorClasses(inner.preludeCode)) {
          add(name, `${atPrelude(block.preludeCode)} {\n  ${inner.text}\n}`);
        }
      }
      continue;
    }
    if (atPrelude(block.preludeCode).startsWith('@')) continue; // @keyframes, @font-face — not a class
    for (const name of selectorClasses(block.preludeCode)) add(name, block.text);
  }
  return out;
}

// Colour literals written outside a var() fallback — the same measure the
// adherence gate uses, and for the same reason: var(--x, #fallback) is how the
// token bridge is built, so counting those would condemn every correct app.
export function hardcodedColors(cssText) {
  const stripped = String(cssText || '').replace(/var\([^)]*\)/g, '');
  return [...new Set(stripped.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || [])];
}

// promotionCandidates({ designCss, appCss }) → what a build invented.
//
// A candidate is a class the app's OWN stylesheet defines that the approved
// design does not. `tokenClean` is the question that decides whether it is the
// design system growing or a second palette starting: an element made of
// var(--…) inherits the theme, follows dark mode, and re-values itself when the
// design is re-approved. One with the colours typed in does none of that, and
// promoting it would make the drift permanent — so it is offered with the
// reason stated, not hidden and not silently accepted.
export function promotionCandidates({ designCss = '', appCss = '' } = {}) {
  const approved = classRules(designCss);
  const mine = classRules(appCss);
  const out = [];
  for (const [name, rules] of mine) {
    if (approved.has(name)) continue;
    const css = rules.join('\n');
    if (css.length > MAX_RULE_CHARS) continue;
    const colors = hardcodedColors(css);
    out.push({
      name,
      css,
      ruleCount: rules.length,
      chars: css.length,
      hardcodedColors: colors,
      tokenClean: colors.length === 0 && /var\(\s*--/.test(css),
      responsive: rules.some((r) => CONDITIONAL_AT.test(r)),
    });
  }
  // Token-clean first (the ones worth accepting), then the biggest — a
  // 12-line element is more likely to be a real component than a one-liner.
  return out.sort((a, b) => (b.tokenClean ? 1 : 0) - (a.tokenClean ? 1 : 0) || b.chars - a.chars);
}

// Strip the promoted block out of a stylesheet, returning both halves.
export function splitPromoted(designCss) {
  const text = String(designCss || '');
  const start = text.indexOf(PROMOTED_BEGIN);
  if (start === -1) return { base: text.replace(/\s*$/, ''), promoted: '' };
  const end = text.indexOf(PROMOTED_END, start);
  const stop = end === -1 ? text.length : end + PROMOTED_END.length;
  return {
    base: (text.slice(0, start) + text.slice(stop)).replace(/\s*$/, ''),
    promoted: text.slice(start + PROMOTED_BEGIN.length, end === -1 ? text.length : end).trim(),
  };
}

// promoteInto(designCss, elements) → { css, promoted, skipped }.
//
// Idempotent: promoting the same element twice replaces its rules rather than
// appending a second copy, because a promotion is a statement about what the
// element IS, and two copies is how a stylesheet starts contradicting itself.
// An element the base design already defines is skipped — the mockup wins, or
// re-approving the design would silently lose to a stale promotion.
export function promoteInto(designCss, elements = []) {
  const { base, promoted } = splitPromoted(designCss);
  const approved = classRules(base);
  const existing = new Map();
  for (const block of splitPromotedEntries(promoted)) existing.set(block.name, block.css);

  const accepted = [];
  const skipped = [];
  for (const el of (Array.isArray(elements) ? elements : []).slice(0, MAX_PROMOTE_AT_ONCE)) {
    const name = String(el?.name || '').trim();
    const css = String(el?.css || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,}$/.test(name) || !css) {
      skipped.push({ name, reason: 'not a usable element' });
      continue;
    }
    if (css.length > MAX_RULE_CHARS) {
      skipped.push({ name, reason: `its CSS is ${css.length} characters — an element, not a stylesheet` });
      continue;
    }
    if (approved.has(name)) {
      skipped.push({ name, reason: 'the approved design already defines it' });
      continue;
    }
    existing.set(name, css);
    accepted.push(name);
  }

  const entries = [...existing.entries()]
    .map(([name, css]) => `/* --- .${name} --- */\n${css.trim()}`)
    .join('\n\n');
  const css = entries
    ? `${base}\n\n${PROMOTED_BEGIN}\n${entries}\n${PROMOTED_END}\n`
    : `${base}\n`;
  return { css, promoted: accepted, skipped };
}

// The promoted block back into { name, css } entries. Parsed from the same
// marker comment promoteInto writes, so the block round-trips.
export function splitPromotedEntries(promotedBlock) {
  const text = String(promotedBlock || '');
  const re = /\/\* --- \.([A-Za-z][A-Za-z0-9_-]{1,}) --- \*\//g;
  const marks = [...text.matchAll(re)];
  return marks.map((m, i) => ({
    name: m[1],
    css: text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : text.length).trim(),
  })).filter((e) => e.css);
}

// The chat line the design review posts when a build invented something.
//
// Posted with the critique because that is when the operator is already looking
// at the app's screens: "here is what it looks like, and here is the element it
// made up while building it — keep it or lose it."
export function promotionInviteMessage(candidates = []) {
  const clean = (Array.isArray(candidates) ? candidates : []).filter((c) => c.tokenClean);
  if (!clean.length) return '';
  const names = clean.slice(0, 6).map((c) => `\`.${c.name}\``).join(', ');
  const more = clean.length > 6 ? ` (and ${clean.length - 6} more)` : '';
  return `This build designed ${clean.length} element${clean.length === 1 ? '' : 's'} the approved design does not have — ${names}${more} — and built ${clean.length === 1 ? 'it' : 'them'} entirely from the approved variables. Promote the ones worth keeping in **Design → New elements** and they become part of the design: later builds inherit them, and the adherence check counts them instead of marking them as vocabulary the app invented.`;
}
