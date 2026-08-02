// The annotate bridge injected into every scaffolded app.
//
// The bridge is a template STRING, so a typo in it is invisible until an
// operator opens annotate mode on a real app. These assert the rendered file
// parses, and pin the three behaviours that were wrong before:
//
//   1. A scroll gesture used to end in a click and drop a stray pin — which
//      matters most on a phone, where scrolling is the ONLY way to reach
//      anything below the fold.
//   2. Pin coordinates were viewport-relative only, so once the operator
//      scrolled, "y% from the top" pointed at the wrong part of the page.
//   3. Pins carried no page identity, so pins dropped on two screens were all
//      reported against whichever screen happened to be showing.
//
// Native-free: pure string checks + a syntax parse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildScaffoldFiles } from '../mock2/scaffold.js';

const BRIDGE_PATH = 'public/pp-annotate-bridge.js';
const bridge = () => {
  const f = buildScaffoldFiles({ id: 1, name: 'probe' }).find((x) => x.path === BRIDGE_PATH);
  assert.ok(f, `${BRIDGE_PATH} must be part of the scaffold`);
  return f.content;
};

test('the rendered annotate bridge is syntactically valid JavaScript', () => {
  // A template-literal typo (an unescaped backtick, a broken \\s) produces a
  // file that throws on load and silently disables annotate on every app.
  assert.doesNotThrow(() => new vm.Script(bridge(), { filename: BRIDGE_PATH }));
});

test('the bridge is inert until the dashboard enables it', () => {
  const s = bridge();
  // Embedded-only, and no listeners bound before an explicit enable.
  assert.match(s, /window\.self === window\.top/);
  const enable = s.slice(s.indexOf('function enable()'), s.indexOf('function disable()'));
  assert.match(enable, /addEventListener\('click', onClick, true\)/);
  // disable() must remove everything enable() added, or a "Done" leaves the
  // app permanently swallowing clicks.
  const disable = s.slice(s.indexOf('function disable()'));
  for (const ev of ['pointerdown', 'pointerup', 'click']) {
    assert.ok(enable.includes(`addEventListener('${ev}'`), `enable must bind ${ev}`);
    assert.ok(disable.includes(`removeEventListener('${ev}'`), `disable must unbind ${ev}`);
  }
});

test('a drag scrolls instead of pinning', () => {
  const s = bridge();
  // The threshold is the whole fix: without it every scroll leaves a pin.
  assert.match(s, /SLOP\s*=\s*\d+/);
  assert.match(s, /function movedTooFar/);
  const onClick = s.slice(s.indexOf('function onClick'), s.indexOf('function enable()'));
  assert.match(onClick, /if \(drag\) return;/, 'a drag must return before posting a pin');
  // The guard has to run BEFORE preventDefault, or a scroll still eats the tap.
  assert.ok(onClick.indexOf('if (drag) return;') < onClick.indexOf('preventDefault'),
    'the drag check must precede preventDefault');
});

test('pins carry document-relative coordinates and their page', () => {
  const s = bridge();
  const onClick = s.slice(s.indexOf('function onClick'), s.indexOf('function enable()'));
  // Viewport coords for drawing the badge...
  assert.match(onClick, /pin\.x = clamp\(e\.clientX/);
  // ...and document coords for SAYING where it is. Both are needed: the badge
  // is drawn over the frame, the instruction describes the page.
  assert.match(onClick, /pageYOffset/);
  assert.match(onClick, /pin\.pageY = clamp/);
  assert.match(onClick, /pin\.scrolled/);
  // Page identity goes through the one pageId() — location-based for apps,
  // active data-screen for the inlined mockup copy (asserted below).
  assert.match(onClick, /pin\.page = pageId\(\);/);
});

test('SPA navigation is announced, not just full page loads', () => {
  const s = bridge();
  // A client-rendered app never fires load on navigation, so history has to be
  // wrapped or the host never learns the screen changed.
  assert.match(s, /pushState/);
  assert.match(s, /popstate/);
  assert.match(s, /function announcePage/);
  // Wrapping must be idempotent — enable/disable cycles must not stack wrappers.
  assert.match(s, /__ppWrapped/);
  // And it starts watching immediately, so the first reported page is real.
  assert.match(s, /watchNavigation\(\);/);
});

test('the bridge never reports on a page it was not asked about', () => {
  const s = bridge();
  // announcePage de-duplicates, so the 700ms safety poll does not spam the
  // host with a message every tick.
  const fn = s.slice(s.indexOf('function announcePage'), s.indexOf('function watchNavigation'));
  assert.match(fn, /if \(page === lastPage\) return;/);
});

test('mockup mode: page identity comes from the active data-screen section', () => {
  const s = bridge();
  // The mockup preview inlines this same script (window.__ppMockupPreview set
  // first): its route never changes, so the active section[data-screen] is the
  // page identity, as "/#screen" — the same key the screen picker uses.
  assert.match(s, /window\.__ppMockupPreview/);
  assert.match(s, /section\[data-screen\]\.screen-active/);
  assert.match(s, /'\/#' \+ /);
  // Both the pin and the page announcement go through the one pageId().
  assert.match(s, /pin\.page = pageId\(\);/);
  assert.match(s, /var page = pageId\(\);/);
  // The enclosing screen rides each pin's element description too.
  assert.match(s, /screen: scrEl \? scrEl\.getAttribute\('data-screen'\) : null/);
});

test('the bridge can be inlined into a served HTML document', async () => {
  // The mockup route embeds the source inside a <script> tag — a literal
  // "</script>" anywhere in it would truncate the element and break the page.
  const { ppAnnotateBridgeJs } = await import('../mock2/scaffold.js');
  const src = ppAnnotateBridgeJs();
  assert.ok(!/<\/script/i.test(src), 'bridge source must not contain a script close tag');
  assert.equal(src, bridge(), 'the inlined bridge and the scaffolded file are the same script');
});
