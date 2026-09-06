// PWA registration and the update watch.
//
// THE REQUIREMENT: when the server is updated, nobody stays on the old build.
//
// The service worker's network-first navigation strategy already guarantees a
// full page load picks up a new deploy. This layer covers the case that
// strategy cannot: an admin console tab that has been open for days and is
// never reloaded. It asks the browser to re-check for a new worker on a timer
// and whenever the tab comes back to the foreground, and it tells the app when
// one is waiting so the operator can take it.
//
// Why not just reload automatically? This console drives live builds. Yanking
// the page out from under someone mid-instruction loses what they typed. The
// operator is asked; the reload is one tap.

const UPDATE_POLL_MS = 60_000;

let registration = null;
let reloading = false;

// Called with no arguments when a new version has finished installing and is
// waiting. Set by the app (see main.jsx) — kept as a plain callback so this
// module has no React dependency.
let onUpdateReady = null;

export function setUpdateHandler(fn) {
  onUpdateReady = typeof fn === 'function' ? fn : null;
  // A worker may already be waiting by the time the handler is attached (the
  // update can land before React mounts). Fire immediately rather than waiting
  // for the next poll, or the very first update after a deploy is missed.
  if (onUpdateReady && registration?.waiting && navigator.serviceWorker.controller) onUpdateReady();
}

// Accept the update: tell the waiting worker to take over. The controllerchange
// listener below does the reload once it has.
export function applyUpdate() {
  const waiting = registration?.waiting;
  if (!waiting) { window.location.reload(); return; }
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

function watch(reg) {
  const check = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // 'installed' WITH an existing controller means this is an update, not a
      // first install. Without the controller check, a brand-new visitor would
      // be told a moment after arriving that a new version is available.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        if (onUpdateReady) onUpdateReady();
      }
    });
  };
  check(reg.installing);
  if (reg.waiting && navigator.serviceWorker.controller && onUpdateReady) onUpdateReady();
  reg.addEventListener('updatefound', () => check(reg.installing));
}

export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  // The dev server does not emit sw.js (the plugin is build-only), and a stale
  // worker from a production visit would otherwise intercept dev traffic.
  if (import.meta.env.DEV) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => undefined);
    return;
  }

  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then((reg) => {
      registration = reg;
      watch(reg);

      const poll = () => { reg.update().catch(() => undefined); };
      // On a timer for a tab left open, and on every return to the foreground —
      // which is when a phone user actually comes back to it.
      setInterval(poll, UPDATE_POLL_MS);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
      window.addEventListener('online', poll);
      window.addEventListener('focus', poll);
    })
    .catch((err) => console.warn('[pwa] service worker registration failed:', err?.message));

  // The new worker took control — the page is now running against assets that
  // may not match the JS it booted with, so reload. Guarded: controllerchange
  // can fire more than once, and a reload loop is worse than a stale tab.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

// ---- installability ----
//
// Chrome/Edge (desktop and Android) fire beforeinstallprompt ONCE, early — often
// before React has mounted, and always before the operator has navigated to
// Profile. If nothing is listening at that moment the event is gone and the
// page can never show its own Install button. So the listener is attached at
// startup (initInstallPrompt, called from main.jsx) and the captured event is
// held here; any component asks canInstall() and subscribes for changes.
//
// iOS/iPadOS Safari has no such event (install is Share → Add to Home Screen
// only), Firefox desktop has no install at all, and Safari on macOS installs
// via File → Add to Dock. installHint() names the right path for each so the
// UI can give real instructions instead of a button that never appears.
// isStandalone covers every platform so the UI stops offering an install that
// already happened.

let deferredPrompt = null;
let installListenersAttached = false;
const installSubscribers = new Set();

function notifyInstall() {
  const available = !!deferredPrompt;
  installSubscribers.forEach((fn) => { try { fn(available); } catch { /* subscriber's problem */ } });
}

export function initInstallPrompt() {
  if (typeof window === 'undefined' || installListenersAttached) return;
  installListenersAttached = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Suppress the browser's own mini-infobar; the Profile page offers it
    // instead, where the operator can read what installing means.
    e.preventDefault();
    deferredPrompt = e;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notifyInstall();
  });
}

// Kept for callers that attach their own listener; new code should use
// initInstallPrompt + subscribeInstallPrompt.
export function watchInstallPrompt(onAvailable) {
  initInstallPrompt();
  return subscribeInstallPrompt(onAvailable);
}

// subscribeInstallPrompt(fn) → unsubscribe. fn(available: boolean) fires on
// every change; the current state is readable synchronously via canInstall().
export function subscribeInstallPrompt(fn) {
  if (typeof fn !== 'function') return () => undefined;
  installSubscribers.add(fn);
  return () => { installSubscribers.delete(fn); };
}

export function canInstall() {
  return !!deferredPrompt;
}

export async function promptInstall() {
  if (!deferredPrompt) return { ok: false, reason: 'not_available' };
  const evt = deferredPrompt;
  let choice = null;
  try {
    await evt.prompt();
    choice = await evt.userChoice;
  } catch {
    choice = null;
  }
  // The event is single-use whatever the outcome; a dismissed prompt cannot be
  // re-shown until the browser fires a fresh beforeinstallprompt.
  deferredPrompt = null;
  notifyInstall();
  return { ok: choice?.outcome === 'accepted', outcome: choice?.outcome || 'dismissed' };
}

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: window-controls-overlay)').matches
    // iOS Safari's own flag — it does not implement display-mode: standalone
    // on older versions.
    || window.navigator.standalone === true;
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent)
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// installHint() → { platform, steps: string[] } describing how THIS browser
// installs the app when it offers no programmatic prompt. Best-effort UA
// sniffing: it only chooses wording, never gates a feature.
export function installHint() {
  if (typeof navigator === 'undefined') return { platform: 'unknown', steps: [] };
  const ua = navigator.userAgent;
  if (isIOS()) {
    return {
      platform: 'ios',
      steps: [
        'Open this page in Safari (other iPhone browsers cannot install apps).',
        'Tap the Share button, then "Add to Home Screen".',
        'Tap "Add". The app opens full-screen from that icon, and can receive notifications.',
      ],
    };
  }
  if (/Firefox\//.test(ua) && !/Android/.test(ua)) {
    return {
      platform: 'firefox-desktop',
      steps: [
        'Firefox on the desktop does not install web apps. Open ProxyPilot in Chrome, Edge, or Safari to install it.',
      ],
    };
  }
  if (/Firefox\//.test(ua) && /Android/.test(ua)) {
    return {
      platform: 'firefox-android',
      steps: ['Open the browser menu (⋮), then tap "Install" or "Add to Home screen".'],
    };
  }
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) {
    return {
      platform: 'safari-mac',
      steps: ['In Safari, choose File → "Add to Dock…", then click "Add".'],
    };
  }
  // Edge on Android does fire beforeinstallprompt when the site passes, so the
  // button normally shows; these are its menu steps for when it does not. The
  // menu item is "Add to phone" — not "Install app", which is what people go
  // looking for.
  if (/EdgA\//.test(ua)) {
    return {
      platform: 'edge-android',
      steps: [
        'Tap the menu button (≡ or ⋯) in the bottom bar.',
        'Tap "Add to phone" — swipe the row of icons sideways if it is not visible.',
        'Tap "Install".',
      ],
    };
  }
  if (/SamsungBrowser\//.test(ua)) {
    return {
      platform: 'samsung',
      steps: [
        'Tap the install icon (a down-arrow) at the right end of the address bar, if one is showing.',
        'Otherwise open the menu (≡), tap "Add page to", then "Home screen".',
      ],
    };
  }
  if (/Android/.test(ua)) {
    return {
      platform: 'android',
      steps: ['Open the browser menu (⋮), then tap "Install app" or "Add to Home screen".'],
    };
  }
  return {
    platform: 'desktop',
    steps: [
      'Click the install icon at the right end of the address bar, or open the browser menu and choose "Install ProxyPilot…".',
    ],
  };
}

// isInstalledHere() → true when this browser already has the app installed
// (Chromium Android/desktop: navigator.getInstalledRelatedApps, matched
// against the related_applications entry the server puts in the manifest).
// This is THE reason a healthy site shows no install prompt: Chromium fires
// beforeinstallprompt only while the app is not installed. Resolves false
// wherever the API is missing (Safari, Firefox) — unknown is treated as
// "not installed" so the steps still show.
export async function isInstalledHere() {
  if (typeof navigator === 'undefined' || typeof navigator.getInstalledRelatedApps !== 'function') return false;
  try {
    const apps = await navigator.getInstalledRelatedApps();
    return apps.some((a) => a.platform === 'webapp');
  } catch {
    return false;
  }
}

// checkInstallability() → [{ ok, label }] — the criteria Chromium applies
// before it will fire beforeinstallprompt, as far as a page can verify them
// itself. When the button is missing, this turns "nothing happens" into a
// named reason (a manifest that 404s behind a proxy, a service worker that
// never took control, a plain-HTTP origin).
export async function checkInstallability() {
  const out = [];
  if (typeof window === 'undefined') return out;
  out.push({ ok: window.isSecureContext === true, label: 'Served over HTTPS' });

  const swSupported = 'serviceWorker' in navigator;
  let controlled = false;
  if (swSupported) {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      controlled = !!reg && !!navigator.serviceWorker.controller;
    } catch { controlled = false; }
  }
  out.push({ ok: swSupported && controlled, label: 'Service worker installed and in control of this page' });

  let manifest = null;
  let manifestOk = false;
  const link = document.querySelector('link[rel="manifest"]');
  if (link?.href) {
    try {
      const res = await fetch(link.href, { credentials: 'same-origin', cache: 'no-cache' });
      manifestOk = res.ok;
      if (res.ok) manifest = await res.json();
    } catch { manifestOk = false; }
  }
  out.push({ ok: manifestOk, label: 'Web app manifest loads' });
  if (manifest) {
    // Chromium's rule, verbatim from its diagnostic: PNG, SVG or WebP, at
    // least 144px, sizes set ("any" only for SVG), purpose including "any".
    // A GIF/JPEG/ICO or an "any"-sized raster does not count, however large.
    const px = (icon) => Math.max(0, ...String(icon.sizes || '').split(/\s+/).map((s) => parseInt(s, 10) || 0));
    const typeOf = (icon) => (icon.type || (/\.svg(\?|$)/i.test(icon.src) ? 'image/svg+xml' : /\.webp(\?|$)/i.test(icon.src) ? 'image/webp' : /\.png(\?|$)/i.test(icon.src) ? 'image/png' : '')).toLowerCase();
    const suitable = (icon) => {
      const type = typeOf(icon);
      if (!(icon.purpose || 'any').split(/\s+/).includes('any')) return false;
      if (type === 'image/svg+xml') return icon.sizes === 'any' || px(icon) >= 144;
      if (type === 'image/png' || type === 'image/webp') return px(icon) >= 144;
      return false;
    };
    const good = (manifest.icons || []).find(suitable);
    out.push({ ok: !!good, label: 'A PNG, SVG or WebP app icon of at least 144px with a declared size' });
    out.push({ ok: ['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display), label: 'Opens in its own window (display mode)' });
    out.push({ ok: !!(manifest.name || manifest.short_name), label: 'Has an app name' });
    const icon = good;
    if (icon) {
      let iconOk = false;
      // What Chromium actually needs is an icon that DECODES; a content-type
      // header is only a hint, and a static server that omits it is fine.
      try {
        const r = await fetch(new URL(icon.src, link.href).href, { cache: 'no-cache' });
        if (r.ok) {
          const blob = await r.blob();
          if (typeof createImageBitmap === 'function') {
            const bmp = await createImageBitmap(blob);
            iconOk = bmp.width >= 144 && bmp.height >= 144;
            bmp.close?.();
          } else {
            iconOk = blob.size > 0;
          }
        }
      } catch { iconOk = false; }
      out.push({ ok: iconOk, label: 'The app icon downloads' });
    }
    let startOk = false;
    try {
      const r = await fetch(new URL(manifest.start_url || '/', link.href).href, { cache: 'no-cache', credentials: 'same-origin' });
      startOk = r.ok;
    } catch { startOk = false; }
    out.push({ ok: startOk, label: 'The start page loads' });
  }
  return out;
}

// ---- Web Push ----
//
// Three things must all be true before a notification can arrive, and they fail
// in different places, so each is reported distinctly rather than collapsed
// into "push is off":
//
//   1. the browser supports it,
//   2. the OS/browser granted Notification permission,
//   3. this browser has a subscription the server knows about.
//
// The big platform caveat: on iOS/iPadOS, Web Push requires iOS 16.4+ AND the
// site to have been added to the Home Screen. Safari in a normal tab gets no
// push at all, whatever permission says — which is why pushSupport() reports
// `needsInstall` rather than a bare false.

export function pushSupport() {
  if (typeof window === 'undefined') return { supported: false, reason: 'no window' };
  if (!('serviceWorker' in navigator)) return { supported: false, reason: 'This browser has no service worker support.' };
  if (!('PushManager' in window)) {
    // Safari on iOS exposes PushManager ONLY to an installed PWA. Detect the
    // platform so the message is actionable instead of "not supported".
    const iOS = /iP(hone|ad|od)/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (iOS && !isStandalone()) {
      return {
        supported: false,
        needsInstall: true,
        reason: 'On iPhone and iPad, notifications need ProxyPilot added to the Home Screen first: tap Share, then "Add to Home Screen", and open it from that icon.',
      };
    }
    return { supported: false, reason: 'This browser does not support push notifications.' };
  }
  if (!('Notification' in window)) return { supported: false, reason: 'This browser does not support notifications.' };
  return { supported: true, permission: Notification.permission };
}

// The applicationServerKey must be a Uint8Array of the raw key bytes — passing
// the base64url string silently produces a subscription no push will reach.
function urlBase64ToUint8Array(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function getPushSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// subscribeToPush(publicKey) → the PushSubscription JSON the server stores.
// Throws with a readable message; the caller surfaces it.
export async function subscribeToPush(publicKey) {
  const support = pushSupport();
  if (!support.supported) throw new Error(support.reason);
  if (!publicKey) throw new Error('The server has no VAPID public key configured.');

  // Must be requested from a user gesture, or browsers reject it outright.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked for this site. Allow them in the browser\'s site settings, then try again.'
      : 'Notification permission was dismissed.');
  }

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  // A subscription made with a DIFFERENT VAPID key is unusable — the endpoint
  // only accepts pushes signed by the key it was created with. This happens
  // after a key rotation, and without the swap the operator sees a healthy
  // subscription that never delivers.
  if (existing) {
    const same = existing.options?.applicationServerKey
      && new Uint8Array(existing.options.applicationServerKey).every((b, i) => b === urlBase64ToUint8Array(publicKey)[i]);
    if (same) return existing.toJSON();
    await existing.unsubscribe().catch(() => undefined);
  }
  const sub = await reg.pushManager.subscribe({
    // Required by Chrome: a push that shows no notification is not allowed.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  return sub.toJSON();
}

export async function unsubscribeFromPush() {
  const sub = await getPushSubscription();
  if (!sub) return null;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => undefined);
  return endpoint;
}
