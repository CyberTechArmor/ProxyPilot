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
// Chrome fires beforeinstallprompt and lets the page defer it; iOS has no such
// event (Safari installs via Share → Add to Home Screen only). isStandalone
// covers both so the UI can stop offering an install that already happened.

let deferredPrompt = null;

export function watchInstallPrompt(onAvailable) {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (typeof onAvailable === 'function') onAvailable(true);
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    if (typeof onAvailable === 'function') onAvailable(false);
  });
}

export async function promptInstall() {
  if (!deferredPrompt) return { ok: false, reason: 'not_available' };
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice.catch(() => null);
  deferredPrompt = null;
  return { ok: choice?.outcome === 'accepted', outcome: choice?.outcome || 'dismissed' };
}

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    // iOS Safari's own flag — it does not implement display-mode: standalone
    // on older versions.
    || window.navigator.standalone === true;
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
