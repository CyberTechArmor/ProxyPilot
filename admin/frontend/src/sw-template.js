/* ProxyPilot service worker — TEMPLATE.
 *
 * Not shipped as-is: vite.config.js reads this at build time, substitutes
 * __BUILD_ID__, and emits it as /sw.js. See serviceWorkerPlugin for why the
 * byte-stamp matters.
 *
 * THE RULE THIS IS BUILT AROUND: a deploy must never leave someone on the old
 * app. Two independent mechanisms, because either one alone has a failure mode.
 *
 *  1. NAVIGATIONS ARE NETWORK-FIRST. Every page load asks the server for fresh
 *     HTML and only falls back to cache when the network genuinely fails. Fresh
 *     HTML names the new content-hashed asset files, so the whole app updates —
 *     even if the worker itself is somehow stale. A cache-first HTML strategy
 *     is the single most common way a PWA gets stuck on an old build, and it is
 *     the thing being avoided here.
 *
 *  2. THE WORKER ITSELF CHANGES EVERY BUILD (the stamped id below), so the
 *     browser's own update check installs the new one, and activation deletes
 *     every cache that is not this build's.
 *
 * WHAT IS NEVER CACHED: /api. A cached API response is a wrong answer with a
 * long life — stale project state, a stale build status, a stale session check.
 * Those go to the network, always, and fail honestly when offline.
 */

const BUILD_ID = '__BUILD_ID__';
const CACHE = `proxypilot-${BUILD_ID}`;

// The offline fallback. Deliberately tiny: this app is an admin console for
// live infrastructure, so "works offline" means "shows the shell and says the
// network is gone", not "pretends to work".
const APP_SHELL = '/';

self.addEventListener('install', (event) => {
  // Take over as soon as the new worker is ready rather than waiting for every
  // tab to close — with a long-lived admin tab open, waiting can mean days.
  // Safe here because the app reloads on controllerchange (see lib/pwa.js).
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.add(new Request(APP_SHELL, { cache: 'reload' })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Every cache that is not this build's is now garbage. This is what stops
    // storage growing without bound across deploys, and what guarantees a
    // rolled-back build cannot resurrect an older asset.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    // Navigation preload lets the browser start the network request in
    // parallel with booting this worker — it removes the startup latency that
    // makes network-first navigations feel slower than cache-first.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch { /* not supported */ }
    }
    await self.clients.claim();
  })());
});

// The page asks for this when the operator accepts an update.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Not the manifest: the backend rewrites it with the admin's branding (name,
// icon), so a cache-first copy would pin the install icon to a stale look for
// the life of a build. Browsers fetch it rarely, so letting it hit the network
// costs nothing.
const isAsset = (url) => url.pathname.startsWith('/assets/')
  || /\.(?:png|svg|ico|woff2?)$/i.test(url.pathname);

async function networkFirst(event) {
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const res = preload || await fetch(event.request);
    // Only cache a real success. Caching a 404 or an error page is how an
    // offline fallback turns into a permanently broken app.
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(APP_SHELL, copy)).catch(() => undefined);
    }
    return res;
  } catch {
    const cached = await caches.match(APP_SHELL);
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Offline</title><body style="font:15px/1.5 system-ui;background:#0b1524;color:#dbe6f5;'
      + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px">'
      + '<div><h1 style="font-size:17px;margin:0 0 6px">ProxyPilot is offline</h1>'
      + '<p style="margin:0;color:#8fa5c4">This console manages live infrastructure, so it needs a connection. '
      + 'It will reconnect on its own.</p></div>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => undefined);
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  // NEVER the API, and never the websocket/terminal upgrade path. A cached
  // answer here is a wrong answer about live infrastructure.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') { event.respondWith(networkFirst(event)); return; }
  // Content-hashed by the build, so the filename IS the version — cache-first
  // is safe and makes repeat loads instant.
  if (isAsset(url)) { event.respondWith(cacheFirst(request)); }
});

/* ---- Web Push ----
 *
 * The payload arrives already decrypted: the browser did that with the keys it
 * generated for this subscription, which is why the push service could relay it
 * without ever reading it.
 *
 * showNotification MUST be called on every push. A handler that ends without
 * one makes Chrome display its own "This site has been updated in the
 * background" notice and, if it keeps happening, revoke the site's push
 * permission outright. So the failure path below still shows something.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  const title = data.title || 'ProxyPilot';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // A tag REPLACES a previous notification with the same tag rather than
    // stacking — three failures on one project read as one live line, not a
    // pile the operator dismisses one by one.
    tag: data.tag || 'proxypilot',
    renotify: true,
    // Errors should survive being missed; routine successes should not nag.
    requireInteraction: data.level === 'error',
    timestamp: Date.now(),
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const url = new URL(target, self.location.origin).href;
    // Prefer an EXISTING window: an operator with ProxyPilot already open does
    // not want a second copy, they want the one they have to navigate.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      if ('navigate' in client) { try { await client.navigate(url); } catch { /* focus is enough */ } }
      return;
    }
    await self.clients.openWindow(url);
  })());
});

/* The push service can retire an endpoint on its own (key rotation, quota).
 * The browser then fires this, and with no handler the subscription is silently
 * dead — the classic "push worked for a month and then stopped". Re-subscribe
 * with the same VAPID key and tell the server the new endpoint. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription || await self.registration.pushManager.getSubscription();
      const key = (event.newSubscription && event.newSubscription.options.applicationServerKey)
        || (old && old.options.applicationServerKey);
      if (!key) return;
      const fresh = event.newSubscription
        || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch('/api/notifications/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(fresh.toJSON()),
      });
      if (old && old.endpoint && old.endpoint !== fresh.endpoint) {
        await fetch('/api/notifications/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ endpoint: old.endpoint }),
        });
      }
    } catch (err) {
      console.warn('[sw] could not renew the push subscription:', err);
    }
  })());
});
