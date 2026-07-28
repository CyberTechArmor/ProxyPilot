// SELECTOR DIAGNOSIS — "timeout" is not a diagnosis.
//
// THE REPORT THAT CAUSED THIS. Project 47, three cycles, $10.28:
//
//   platform-baseline-signin-legal [anonymous /login]:
//     FAIL — expect_visible [data-legal-footer] .legal-link:
//     locator.waitFor: Timeout 5000ms exceeded.
//
// Everything an operator needs is missing from that line. The `[data-legal-
// footer]` slot WAS on the page; the `.legal-link` inside it was not, because
// public/platform.js mounts those links at runtime and the build's rewrite of
// login.html had stopped it running there. One line of markup. Three cycles.
//
// A COMPOUND SELECTOR CARRIES ITS OWN BISECTION. `A B C` failing tells you
// nothing; `A` present, `A B` present, `A B C` absent tells you exactly where
// the tree stops matching. The browser already has the page open, so this
// costs one extra evaluate on the failure path only — never on a passing run.
//
// This is deliberately GENERAL. A table of known-baseline explanations would
// have fixed this one report and nothing else; the app's own checks fail with
// the same useless line every day. The named causes below are a small bonus on
// top of the bisection, not the mechanism.
//
// PURE (stub-first, risk R9). Terminology (risk R7): nothing here is an "agent".

// Split a selector on DESCENDANT combinators only. `>`/`+`/`~` are left inside
// their part: a prefix ending in `>` is not a valid selector, and reporting
// "the invalid prefix `div >` matched nothing" would be worse than silence.
// Bracketed attribute values and quoted strings can contain spaces, so this
// tracks depth rather than calling split(' ').
export function selectorPrefixes(selector) {
  const s = String(selector || '').trim();
  if (!s) return [];
  const parts = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  for (const ch of s) {
    if (quote) { buf += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[' || ch === '(') depth += 1;
    if (ch === ']' || ch === ')') depth -= 1;
    if (ch === ' ' && depth === 0) { if (buf.trim()) parts.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  // Every prefix must itself be a VALID selector, so one that would end in a
  // combinator is skipped rather than probed — `div >` matches nothing for
  // reasons that have nothing to do with the page. The left side is still
  // emitted: knowing `div` is present while `div > span` is not is exactly the
  // bisection this exists for, so a combinator must bind without swallowing
  // what precedes it.
  const out = [];
  for (let i = 1; i <= parts.length; i++) {
    const last = parts[i - 1];
    if (['>', '+', '~'].includes(last) || /[>+~]$/.test(last)) continue;
    out.push(parts.slice(0, i).join(' '));
  }
  return out.length < 2 ? [] : out;   // one part is nothing to bisect
}

// Named causes. Small, and only for things whose fix is NOT guessable from the
// bisection alone — the legal footer's contents come from a script, which no
// amount of looking at the markup reveals.
const CAUSES = [
  {
    match: (sel) => /\[data-legal-footer\]\s*\.legal-link/.test(sel),
    when: 'containerPresent',
    text: 'The [data-legal-footer] slot is on the page but empty. public/platform.js mounts the copyright '
      + 'notice and the Privacy / Terms links into every such slot at runtime — so an empty slot means that '
      + 'script is not running on this page. Check the page still includes platform.js (a rewritten '
      + 'login.html is the usual cause) and that nothing earlier on the page throws.',
  },
  {
    match: (sel) => /\[data-legal-footer\]/.test(sel),
    when: 'absent',
    text: 'The page has no [data-legal-footer] slot at all. Every page must carry one — platform.js fills it; '
      + 'a page that omits it silently ships with no copyright notice and no Privacy / Terms links.',
  },
  {
    match: (sel) => /\.theme-toggle/.test(sel),
    when: 'absent',
    text: 'The theme control is missing. It may be behind a menu — declare the opener as `menuOpener` in '
      + 'state/shell.json and the check will open it before looking.',
  },
];

// diagnoseSelector — turn a failed expect_visible into a sentence.
//
// `probe` maps a selector to whether it is PRESENT in the DOM (present, not
// visible: an element hidden by a parent still tells you the tree matched).
// Passing it in keeps this pure and lets the tests drive every branch.
export function diagnoseSelector(selector, probe) {
  const prefixes = selectorPrefixes(selector);
  let deepest = '';
  for (const p of prefixes.slice(0, -1)) {
    if (!probe(p)) break;
    deepest = p;
  }
  const containerPresent = !!deepest;
  const cause = CAUSES.find((c) => c.match(String(selector || ''))
    && (c.when === (containerPresent ? 'containerPresent' : 'absent')));
  return { deepest, containerPresent, cause: cause ? cause.text : '' };
}

// The detail line the report carries. Built separately from the diagnosis so a
// caller that only wants the facts is not forced through the prose.
export function diagnosisDetail(selector, { deepest = '', containerPresent = false, cause = '' } = {}) {
  const parts = [];
  if (containerPresent) {
    parts.push(`"${deepest}" IS present — the tree stops matching after it`);
  } else if (selectorPrefixes(selector).length) {
    parts.push('not even the first part of the selector matched anything');
  }
  if (cause) parts.push(cause);
  return parts.join('. ');
}
