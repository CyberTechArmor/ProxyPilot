// Mock2 SHELL CONTRACT — how an app may restructure the base app's chrome.
//
// THE BUG THIS FIXES, reported as: "I was able to get some changes done in the
// top nav bar but it seemed to be blocked during larger changes (say if asking
// to hide it or move it to the side)."
//
// It was not a refusal. `public/app-shell.html` is app-owned and a build may
// edit it freely. What blocked the change was the platform's own baseline
// check, which asserted:
//
//     expect_visible: 'header'
//     expect_visible: '.theme-toggle'
//     expect_visible: '[data-legal-footer]'
//
// So a build that HID the nav, or moved it to a sidebar, or folded the theme
// control into a menu, went red for doing exactly what it was asked. Padding
// tweaks passed because they leave the header visible; anything structural
// failed. That is why small changes worked and large ones did not.
//
// THE MISTAKE WAS ASSERTING SHAPE INSTEAD OF GUARANTEE. What the platform
// actually promises is that the theme control, the legal pages and the admin
// route stay REACHABLE — not that a <header> element is visible on the default
// screen. "There is a header" is one implementation of that promise, and the
// check had frozen the implementation.
//
// So the app declares its shell in `state/shell.json`, and the baseline checks
// read it. A sidebar is a declared layout, not a gate failure. A theme control
// behind a menu is fine as long as the app says which control opens the menu —
// the check opens it and then asserts, so the guarantee is still proven.
//
// WHAT REMAINS NON-NEGOTIABLE, whatever the contract says: the theme control,
// the legal footer and the admin route must all be reachable in at most one
// interaction from the default screen. A contract that could drop them would
// not be a contract, it would be an off switch for the checks.
//
// PURE (stub-first, risk R9). Terminology (risk R7): nothing here is an "agent".

export const SHELL_CONTRACT_PATH = 'state/shell.json';

export const NAV_LAYOUTS = Object.freeze(['top', 'side', 'hidden']);

// What every project gets when it has never declared anything — exactly the
// behaviour that shipped before this existed, so an app that says nothing is
// checked precisely as it was.
export const DEFAULT_SHELL = Object.freeze({
  nav: 'top',
  navSelector: 'header',
  menuOpener: '',
  themeSelector: '.theme-toggle',
  legalSelector: '[data-legal-footer]',
});

// parseShellContract — tolerant of everything except a claim that would let the
// guarantees disappear.
export function parseShellContract(text) {
  let doc;
  try { doc = JSON.parse(String(text || '')); } catch { return { ...DEFAULT_SHELL }; }
  if (!doc || typeof doc !== 'object') return { ...DEFAULT_SHELL };
  const str = (v, fallback) => {
    const s = String(v ?? '').trim();
    // A selector with a quote or a newline in it would break the check spec it
    // is spliced into; an app that writes one gets the default rather than a
    // broken battery.
    return s && s.length <= 120 && !/["'\n]/.test(s) ? s : fallback;
  };
  const nav = NAV_LAYOUTS.includes(doc.nav) ? doc.nav : DEFAULT_SHELL.nav;
  return {
    nav,
    // A hidden nav has no container to point at, so the selector is dropped
    // rather than left pointing at something that is deliberately not there.
    navSelector: nav === 'hidden' ? '' : str(doc.navSelector, DEFAULT_SHELL.navSelector),
    menuOpener: str(doc.menuOpener, ''),
    themeSelector: str(doc.themeSelector, DEFAULT_SHELL.themeSelector),
    legalSelector: str(doc.legalSelector, DEFAULT_SHELL.legalSelector),
  };
}

// The steps that prove the shell's guarantees under THIS app's layout.
//
// `openFirst` is the whole point: a control behind a menu is still reachable,
// and a check that cannot open a menu is a check that has banned menus.
export function shellShellSteps(shell = DEFAULT_SHELL) {
  const s = { ...DEFAULT_SHELL, ...(shell || {}) };
  const steps = [];
  // The nav container, when the app says it has one. A hidden nav asserts
  // nothing here — and still has to prove everything below.
  if (s.nav !== 'hidden' && s.navSelector) steps.push({ expect_visible: s.navSelector });
  if (s.menuOpener) steps.push({ click: s.menuOpener });
  steps.push({ expect_visible: s.themeSelector || DEFAULT_SHELL.themeSelector });
  steps.push({ expect_visible: s.legalSelector || DEFAULT_SHELL.legalSelector });
  return steps;
}

// The admin route's steps. Same reasoning: the guarantee is that an
// administrator can GET THERE and use it, not that a <header> is on the page.
export function shellAdminSteps(shell = DEFAULT_SHELL, target = '#add-role') {
  const s = { ...DEFAULT_SHELL, ...(shell || {}) };
  const steps = [];
  if (s.nav !== 'hidden' && s.navSelector) steps.push({ expect_visible: s.navSelector });
  steps.push({ expect_visible: target });
  return steps;
}

// The block that goes into a build's instructions.
//
// The missing half of the fix: a build that was told "never edit platform-owned
// files" and then blocked by a check it could not see had no legitimate path at
// all, so it either fought the gate or gave up. This says where the path is.
export function shellContractInstructions() {
  return `RESTRUCTURING THE APP SHELL (nav, header, theme control, footer).

You MAY change the shell's layout — hide the top nav, move it to a sidebar, fold
its controls into a menu, collapse it on mobile. \`public/app-shell.html\` and the
app's own stylesheet are yours. What you must NOT do is silently drop the base
app's guarantees, and the platform's baseline checks are what hold you to that.

Those checks read \`${SHELL_CONTRACT_PATH}\`. If you change the shell's STRUCTURE,
write that file in the same change — otherwise the checks look for a visible
\`header\` that you deliberately removed and your own change fails:

{
  "nav": "top" | "side" | "hidden",
  "navSelector": "aside.app-nav",   // the nav container, when there is one
  "menuOpener": "#nav-toggle",      // set ONLY if the theme/legal controls are
                                    // behind a menu; the check clicks it first
  "themeSelector": ".theme-toggle",
  "legalSelector": "[data-legal-footer]"
}

Omit any field you did not change. The guarantees themselves are not negotiable
whatever you write: from the default screen, the theme control, the legal footer
and the admin route must each still be reachable in at most one interaction. A
control you moved into a menu is fine; one you deleted is not.`;
}

// A one-line note for the change record, so "why did the shell checks change
// shape this build" has an answer next to the diff.
export function shellContractNote(shell) {
  const s = { ...DEFAULT_SHELL, ...(shell || {}) };
  if (s.nav === DEFAULT_SHELL.nav && !s.menuOpener && s.navSelector === DEFAULT_SHELL.navSelector) return '';
  const bits = [`nav: ${s.nav}`];
  if (s.navSelector) bits.push(`container ${s.navSelector}`);
  if (s.menuOpener) bits.push(`controls behind ${s.menuOpener}`);
  return `shell contract: ${bits.join(', ')} — the baseline checks follow this app's own layout.`;
}
