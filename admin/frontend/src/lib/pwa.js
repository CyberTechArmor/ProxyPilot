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
