// Thin wrapper over the Web Notification API for in-browser build alerts.
//
// The always-available notification channel: when a build finishes, fire an OS
// notification (if the user granted permission) so they hear about it even on
// another tab. Email/SMS are the admin-configured out-of-band channels; this is
// the free, per-user one. Everything here is defensive — a browser without the
// API, or a denied permission, simply no-ops.

export function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notifyPermission() {
  return notifySupported() ? Notification.permission : 'unsupported';
}

// Ask for permission. Safe to call repeatedly; resolves to the final permission
// string ('granted' | 'denied' | 'default' | 'unsupported'). Must be triggered
// from a user gesture in some browsers — the Notifications settings page has an
// explicit "Enable" button for that.
export async function ensureNotifyPermission() {
  if (!notifySupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); }
  catch { return 'default'; }
}

// Fire a notification. Returns true if one was shown. `url` (if given) focuses
// the app when the notification is clicked.
export function notifyBrowser(title, body, { url } = {}) {
  try {
    if (!notifySupported() || Notification.permission !== 'granted') return false;
    const n = new Notification(title, { body: body || '', icon: '/favicon.ico', tag: 'proxypilot-build' });
    n.onclick = () => {
      try {
        window.focus();
        if (url) window.location.assign(url);
        n.close();
      } catch { /* ignore */ }
    };
    return true;
  } catch {
    return false;
  }
}
