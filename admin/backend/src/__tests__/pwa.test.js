// The PWA contract: a deploy must never leave anyone on the old build, and the
// studio must fit the VISIBLE viewport on a phone.
//
// Both were real, reported failures. The mobile one is visible in a screenshot:
// on the design and build pages the composer was clipped mid-sentence and the
// Menu/Chat/Preview bar was entirely off screen — until the browser's URL bar
// auto-hid, at which point it "fixed itself".
//
// Native-free (risk R9): the pure cache policy plus source assertions over the
// built frontend's own files. No DB, no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cacheControlFor, REVALIDATE_ALWAYS, NO_CACHE, IMMUTABLE,
} from '../lib/static-cache-logic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.resolve(HERE, '../../../frontend');
const read = (rel) => readFileSync(path.join(FE, rel), 'utf8');

// ---- the HTTP half: what the browser is allowed to hold on to ----

test('the two files that POINT AT the current build always revalidate', () => {
  // A cached sw.js keeps the old build's rules for up to 24h by spec; a cached
  // index.html pins the app to the old hashed assets however fresh they are.
  for (const f of ['sw.js', 'index.html', 'manifest.webmanifest']) {
    assert.equal(cacheControlFor(`/srv/dist/${f}`), NO_CACHE, `${f} revalidates`);
  }
  assert.deepEqual([...REVALIDATE_ALWAYS].sort(), ['index.html', 'manifest.webmanifest', 'sw.js']);
});

test('content-hashed assets are immutable — the filename IS the version', () => {
  assert.equal(cacheControlFor('/srv/dist/assets/index-BVshekUZ.js'), IMMUTABLE);
  assert.equal(cacheControlFor('/srv/dist/assets/index-abc123.css'), IMMUTABLE);
  // Windows separators, since the middleware hands over whatever the OS uses.
  assert.equal(cacheControlFor('C:\\srv\\dist\\assets\\index-abc.js'), IMMUTABLE);
  // Anything else keeps the middleware default rather than guessing.
  assert.equal(cacheControlFor('/srv/dist/icon-192.png'), null);
  assert.equal(cacheControlFor(''), null);
});

test('an index.html OUTSIDE assets/ is still no-cache, and an asset named like it is not', () => {
  assert.equal(cacheControlFor('/srv/dist/index.html'), NO_CACHE);
  // The rule keys on the basename, so a hashed file merely containing the word
  // is treated as the immutable asset it is.
  assert.equal(cacheControlFor('/srv/dist/assets/index-BVshekUZ.js'), IMMUTABLE);
});

// ---- the service worker: strategy, not just presence ----

test('the service worker template serves NAVIGATIONS network-first', () => {
  // This is the single most important line in the whole feature. Cache-first
  // HTML is how a PWA gets stuck on an old build; network-first means even a
  // stale worker hands back fresh HTML, which names the new assets.
  const sw = read('src/sw-template.js');
  assert.match(sw, /request\.mode === 'navigate'.*networkFirst/s);
  assert.match(sw, /async function networkFirst/);
  // Assets are cache-first, which is only safe because they are hashed.
  assert.match(sw, /isAsset\(url\).*cacheFirst/s);
});

test('the service worker NEVER caches the API', () => {
  // A cached answer about live infrastructure is a wrong answer with a long
  // life — stale build status, stale session check.
  const sw = read('src/sw-template.js');
  assert.match(sw, /pathname\.startsWith\('\/api\/'\)\)\s*return/);
});

test('activation deletes every cache that is not this build', () => {
  const sw = read('src/sw-template.js');
  assert.match(sw, /caches\.keys\(\)/);
  assert.match(sw, /filter\(\(n\) => n !== CACHE\)\.map\(\(n\) => caches\.delete\(n\)\)/);
  assert.match(sw, /clients\.claim\(\)/);
  assert.match(sw, /skipWaiting/);
});

test('the worker carries a per-build id, or the browser never sees an update', () => {
  // A browser installs a new worker only when sw.js differs BYTE-WISE. A
  // static, hand-written sw.js would leave the old worker in charge forever.
  const tpl = read('src/sw-template.js');
  assert.match(tpl, /const BUILD_ID = '__BUILD_ID__'/, 'the template carries the marker');
  const cfg = read('vite.config.js');
  assert.match(cfg, /__BUILD_ID__/, 'and the build substitutes it');
  assert.match(cfg, /emitFile\(\{ type: 'asset', fileName: 'sw\.js'/);

  // If a build has been run, the emitted worker must have a REAL id.
  const built = path.join(FE, 'dist/sw.js');
  if (existsSync(built)) {
    const out = readFileSync(built, 'utf8');
    const m = out.match(/const BUILD_ID = '([^']+)'/);
    assert.ok(m, 'the emitted worker declares a build id');
    assert.notEqual(m[1], '__BUILD_ID__', 'and it was substituted, not shipped as the marker');
    assert.ok(m[1].length >= 6, `and it is a real id (${m[1]})`);
  }
});

test('the app polls for a new worker rather than waiting for a reload', () => {
  // The strategy above covers every page LOAD. This covers the admin tab left
  // open for days, which is the case it cannot reach.
  const pwa = read('src/lib/pwa.js');
  assert.match(pwa, /setInterval\(poll/);
  assert.match(pwa, /visibilitychange/);
  assert.match(pwa, /window\.addEventListener\('online', poll\)/);
  // And it asks before reloading — this console holds half-typed instructions.
  assert.match(pwa, /controllerchange/);
  assert.match(pwa, /if \(reloading\) return/, 'guarded against a reload loop');
  // A first-time visitor must not be told a new version is available.
  assert.match(pwa, /navigator\.serviceWorker\.controller/);
});

test('the dev server tears down any worker left by a production visit', () => {
  const pwa = read('src/lib/pwa.js');
  assert.match(pwa, /import\.meta\.env\.DEV[\s\S]{0,200}unregister/);
});

// ---- installability, on both platforms ----

test('the manifest is installable and the iOS path is covered separately', () => {
  const m = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.start_url && m.scope, 'scoped');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'Chrome needs both');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'Android crops to a mask');
  assert.ok(m.icons.every((i) => i.type === 'image/png'), 'PNG — an SVG icon is not reliably installable');

  const html = read('index.html');
  assert.match(html, /rel="manifest"/);
  // iOS ignores the manifest's icons entirely; without this the home-screen
  // tile is blank.
  assert.match(html, /rel="apple-touch-icon" href="\/icon-180\.png"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /name="theme-color"/);
  for (const f of ['public/icon-180.png', 'public/icon-192.png', 'public/icon-512.png']) {
    const buf = readFileSync(path.join(FE, f));
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${f} is a real PNG`);
  }
});

// ---- the mobile viewport ----

test('the studio is sized to the VISIBLE viewport, not the large one', () => {
  // 100vh is the LARGE viewport on Android Chrome/Edge AND iOS Safari — the
  // height the page would have with the URL bar hidden. Pinning the layout to
  // it put the bottom bar ~110px below the fold whenever the bar was showing.
  const css = read('src/index.css');
  assert.match(css, /\.h-viewport\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;/s,
    'dvh with a vh fallback, in that order — iOS < 15.4 ignores the dvh line');
  assert.match(css, /\.pb-safe\s*\{[^}]*env\(safe-area-inset-bottom/s);

  const layout = read('src/components/Layout.jsx');
  assert.match(layout, /h-viewport/, 'the app shell uses it');
  // Only a className may not carry it; the comment above the element explains
  // WHY h-screen is wrong and must stay readable.
  const classNames = [...layout.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
  assert.ok(!classNames.some((c) => /\bh-screen\b/.test(c)), 'no className uses h-screen');
});

test('the bottom bar clears the iPhone home indicator', () => {
  // env() is 0 without viewport-fit=cover, so the meta tag is load-bearing.
  assert.match(read('index.html'), /viewport-fit=cover/);
  assert.match(read('src/components/mock2/MobilePanelBar.jsx'), /pb-safe/);
});

// ---- mobile studio: three reported defects ----

test('the nav drawer can actually scroll to every item', () => {
  // THE BUG: the nav was `flex-1` with no min-h-0 and no overflow. A flex-1
  // child has min-height:auto, so it refuses to shrink below its content — the
  // list overflowed the drawer and everything past "Users" was unreachable.
  // No scrollbar, no scroll, no way down.
  const layout = read('src/components/Layout.jsx');
  const nav = layout.match(/<nav className="([^"]+)"/);
  assert.ok(nav, 'the drawer has a nav');
  for (const cls of ['flex-1', 'min-h-0', 'overflow-y-auto']) {
    assert.ok(nav[1].includes(cls), `the nav needs ${cls} to scroll (has: ${nav[1]})`);
  }
});

test('the drawer ends at the VISIBLE bottom, not the large viewport', () => {
  // `inset-y-0` on a FIXED element resolves against the initial containing
  // block, which on mobile is the large viewport — so the drawer extended under
  // the URL bar and its own footer was unreachable even once the nav scrolled.
  const layout = read('src/components/Layout.jsx');
  const aside = layout.slice(layout.indexOf('<aside'), layout.indexOf('<aside') + 600);
  assert.match(aside, /h-viewport/);
  assert.ok(!/"[^"\n]*\binset-y-0\b[^"\n]*"/.test(aside), 'no inset-y-0 on the fixed drawer');
});

test('the checkout bar is off the phone studio but still reachable in Details', () => {
  // It took a third of the screen from the conversation, which is the whole
  // reason to open ProxyPilot on a phone. Hidden there, shown in Details.
  const page = read('src/pages/ProjectDetail.jsx');
  assert.match(page, /hidden sm:block">\s*\n\s*<LockBanner/, 'hidden on a phone in the studio');
  assert.match(page, /sm:hidden">\s*\n\s*<LockBanner/, 'and present in Details, where a phone can reach it');
});
